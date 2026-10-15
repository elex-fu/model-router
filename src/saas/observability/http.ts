import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PlatformAdminAccessRequest, PlatformAdminActor } from '../platform/access/types.js';
import type { AlertEventRecord, AlertRuleRecord } from './alerts.js';
import type { ChannelStatusPage, ChannelStatusPageQuery } from './channel-status.js';
import { renderSaasMetrics } from './metrics.js';
import { type QpsSnapshot, qpsSnapshot } from './qps-feed.js';

/**
 * Phase 3 observability HTTP surface (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 items 1-4).
 *
 * One read-only handler mounted on the control-plane listener chain:
 * - GET /metrics — unauthenticated Prometheus exposition (counts only, no
 *   secrets; deployments should still restrict network access to scrapers);
 * - GET /admin/api/v1/ops/qps-stream — SSE fan-out of one shared QPS snapshot
 *   per connected console (sub2api's "one snapshot for all connections");
 * - GET /admin/api/v1/ops/channel-status — availability rollup;
 * - GET /admin/api/v1/ops/alert-rules and /alert-events — alert read models.
 *
 * Alert rule writes stay service-level (ObservabilityAlertService) instead of
 * duplicating the platform write CSRF machinery in a second handler.
 */

export interface ObservabilityHttpOptions {
  /** Platform session authenticator; ops JSON/SSE routes require a session. */
  readonly access?: Pick<PlatformAccessLike, 'authenticate'>;
  readonly channelStatus?: (query: ChannelStatusPageQuery) => Promise<ChannelStatusPage>;
  readonly alertRules?: () => Promise<readonly AlertRuleRecord[]>;
  readonly alertEvents?: (limit: number) => Promise<readonly AlertEventRecord[]>;
  /** Gauge refresh executed before each Prometheus scrape. */
  readonly refreshMetrics?: () => Promise<void>;
  readonly snapshot?: () => QpsSnapshot;
  readonly now?: () => number;
}

interface PlatformAccessLike {
  authenticate(request: PlatformAdminAccessRequest): Promise<PlatformAdminActor | undefined>;
}

export type ObservabilityHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const METRICS_PATH = '/metrics';
const OPS_PREFIX = '/admin/api/v1/ops';
const QPS_STREAM_PATH = `${OPS_PREFIX}/qps-stream`;
const CHANNEL_STATUS_PATH = `${OPS_PREFIX}/channel-status`;
const ALERT_RULES_PATH = `${OPS_PREFIX}/alert-rules`;
const ALERT_EVENTS_PATH = `${OPS_PREFIX}/alert-events`;

function requestPath(req: IncomingMessage): string | undefined {
  try {
    const pathname = new URL(req.url ?? '/', 'http://saas-observability.invalid').pathname;
    return pathname.length <= 2048 ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

async function authenticatedActor(options: ObservabilityHttpOptions, req: IncomingMessage): Promise<boolean> {
  if (!options.access) return false;
  const actor = await options.access.authenticate(req);
  return actor !== undefined && actor !== null && typeof actor.userId === 'string';
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
}

function writeSseFrame(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Builds the observability read-only HTTP handler. */
export function createObservabilityHttpHandler(options: ObservabilityHttpOptions): ObservabilityHttpHandler {
  const snapshot = options.snapshot ?? qpsSnapshot;
  return async (req, res): Promise<boolean> => {
    const path = requestPath(req);
    if (path === undefined) return false;
    const method = (req.method ?? 'GET').toUpperCase();
    // Exact-path matching only: the /admin/api/v1/ops/ prefix is shared with
    // other operator routes, so this handler must never swallow them.
    if (
      path !== METRICS_PATH &&
      path !== QPS_STREAM_PATH &&
      path !== CHANNEL_STATUS_PATH &&
      path !== ALERT_RULES_PATH &&
      path !== ALERT_EVENTS_PATH
    ) {
      return false;
    }

    if (path === METRICS_PATH) {
      drainRequest(req);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported for metrics');
        return true;
      }
      try {
        await options.refreshMetrics?.();
      } catch {
        // A failed gauge refresh must never break the scrape; stale gauges are
        // still more useful than a 500 to Prometheus.
      }
      const body = Buffer.from(await renderSaasMetrics(), 'utf8');
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      res.end(body);
      return true;
    }

    if (!(await authenticatedActor(options, req))) {
      drainRequest(req);
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication is required');
      return true;
    }

    if (path === QPS_STREAM_PATH) {
      if (method !== 'GET') {
        drainRequest(req);
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported for the QPS stream');
        return true;
      }
      if (res.destroyed) return true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      });
      writeSseFrame(res, 'snapshot', snapshot());
      const push = setInterval(() => writeSseFrame(res, 'snapshot', snapshot()), 2_000);
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': heartbeat\n\n');
      }, 20_000);
      req.once('close', () => {
        clearInterval(push);
        clearInterval(heartbeat);
      });
      return true;
    }

    if (path === CHANNEL_STATUS_PATH) {
      drainRequest(req);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported for channel status');
        return true;
      }
      if (!options.channelStatus) {
        sendError(res, 503, 'CHANNEL_STATUS_UNAVAILABLE', 'Channel status aggregation is not available');
        return true;
      }
      const url = new URL(req.url ?? '/', 'http://saas-observability.invalid');
      const daysRaw = url.searchParams.get('days');
      const days = daysRaw === null ? undefined : Number.parseInt(daysRaw, 10);
      try {
        const page = await options.channelStatus(days === undefined || !Number.isInteger(days) ? {} : { days });
        sendJson(res, 200, { data: page });
      } catch {
        sendError(res, 500, 'INTERNAL_ERROR', 'The channel status page could not be read');
      }
      return true;
    }

    if (path === ALERT_RULES_PATH) {
      drainRequest(req);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Alert rule writes are service-level only');
        return true;
      }
      if (!options.alertRules) {
        sendError(res, 503, 'ALERTS_UNAVAILABLE', 'Alert rules are not available');
        return true;
      }
      try {
        sendJson(res, 200, { data: { rules: await options.alertRules() } });
      } catch {
        sendError(res, 500, 'INTERNAL_ERROR', 'Alert rules could not be read');
      }
      return true;
    }

    if (path === ALERT_EVENTS_PATH) {
      drainRequest(req);
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported for alert events');
        return true;
      }
      if (!options.alertEvents) {
        sendError(res, 503, 'ALERTS_UNAVAILABLE', 'Alert events are not available');
        return true;
      }
      const url = new URL(req.url ?? '/', 'http://saas-observability.invalid');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
      try {
        sendJson(res, 200, { data: { events: await options.alertEvents(limit ?? 50) } });
      } catch {
        sendError(res, 500, 'INTERNAL_ERROR', 'Alert events could not be read');
      }
      return true;
    }

    drainRequest(req);
    sendError(res, 404, 'NOT_FOUND', 'Not found');
    return true;
  };
}
