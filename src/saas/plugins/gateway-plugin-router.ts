/**
 * Batch-5 §5.1 gateway-side plugin routing (the roadmap's stated landing
 * point: an optional layer at the Claude transport exit, implemented as a
 * `PreparedEvidenceTransport` decorator — the ProviderSseUsageObservingTransport
 * precedent).
 *
 * Routing decision per request (in order):
 *
 * 1. The DB binding for `claude.oauth.outbound_transport.v1` is absent or
 *    the account is outside the stable rollout bucket → the inner (native
 *    claude) transport, byte-for-byte. No plugin installed = zero behavior
 *    change.
 * 2. Binding enabled + account bucketed → the plugin-host route snapshot
 *    must show the SAME plugin available. If it does not (plugin-host
 *    unreachable, runtime unhealthy, another instance still starting) the
 *    request FAILS CLOSED with a structured 502 — never a silent fallback
 *    onto the native path (the reconcile fail-closed rule: the operator
 *    explicitly enabled the plugin for these accounts).
 * 3. The forward itself: request built with the Claude mimicry headers
 *    WITHOUT authorization (the plugin injects it from its session
 *    envelope); the response stream is observed with the same
 *    MessagesUsageWatcher the native transport uses, so billing/settlement
 *    are identical across both paths.
 *
 * request_sent semantics: a plugin failure before anything may have reached
 * upstream is a clean 502 (metered known non-success, no account eviction);
 * a failure after the begin frame may have reached upstream — that error is
 * rethrown so dispatch records an UNKNOWN outcome. Automatic replay or
 * account failover is forbidden in both cases for request_sent=true.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClaudeMessagesUsage } from '../gateway/claude/response-bridge.js';
import {
  buildClaudeOutboundHeadersSansAuth,
  type ClaudeRequestIdentityContext,
  claudeUsageToObservedUsage,
  MessagesUsageWatcher,
} from '../gateway/claude/transport.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../gateway/prepared-request-evidence-service.js';
import type { PluginForwardRequestWire, PluginRoutesWire } from './protocol.js';
import { accountInPluginRollout, type PluginCapabilityId, PluginTransportError } from './types.js';

const ROUTE_CACHE_TTL_MS = 1_000;

export interface EnabledPluginBinding {
  readonly capability: PluginCapabilityId;
  readonly pluginKey: string;
  readonly rolloutPercent: number;
}

/**
 * Reads the authoritative binding truth from the gateway's own database
 * (read-only role grants, migration 128). A read failure throws — the
 * decorator then fails closed rather than guessing "no plugins".
 */
export interface PluginRouteReader {
  enabledBinding(capability: PluginCapabilityId): Promise<EnabledPluginBinding | null>;
}

export interface PostgresPluginRouteReaderOptions {
  readonly executor: { query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> };
  readonly cacheTtlMs?: number;
  readonly nowMs?: () => number;
}

interface BindingRow {
  readonly capability: string;
  readonly plugin_key: string;
  readonly rollout_percent: number;
}

export class PostgresPluginRouteReader implements PluginRouteReader {
  private readonly options: Required<PostgresPluginRouteReaderOptions>;
  private cache: { at: number; rows: BindingRow[] } | null = null;

  constructor(options: PostgresPluginRouteReaderOptions) {
    this.options = {
      ...options,
      cacheTtlMs: options.cacheTtlMs ?? ROUTE_CACHE_TTL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
  }

  async enabledBinding(capability: PluginCapabilityId): Promise<EnabledPluginBinding | null> {
    let rows: BindingRow[];
    const now = this.options.nowMs();
    if (this.cache !== null && now - this.cache.at <= this.options.cacheTtlMs) {
      rows = this.cache.rows;
    } else {
      const result = await this.options.executor.query<BindingRow>(
        `SELECT b.capability, i.plugin_key, b.rollout_percent
           FROM saas_plugin_bindings b
           JOIN saas_plugin_installations i ON i.id = b.installation_id
          WHERE b.enabled AND b.rollout_percent > 0 AND i.state IN ('enabled', 'starting', 'error')`,
        [],
      );
      rows = result.rows;
      this.cache = { at: now, rows };
    }
    const match = rows.find((row) => row.capability === capability);
    return match === undefined
      ? null
      : { capability, pluginKey: match.plugin_key, rolloutPercent: match.rollout_percent };
  }
}

/** Gateway→plugin-host HTTP client (internal token, streaming forward). */
export interface PluginHostClientOptions {
  readonly baseUrl: string;
  readonly internalToken: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly cacheTtlMs?: number;
  readonly nowMs?: () => number;
}

export class PluginHostClient {
  private readonly options: Required<PluginHostClientOptions>;
  private routeCache: { at: number; routes: PluginRoutesWire | null } | null = null;

  constructor(options: PluginHostClientOptions) {
    this.options = {
      ...options,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      cacheTtlMs: options.cacheTtlMs ?? ROUTE_CACHE_TTL_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
  }

  /**
   * The route snapshot, or null when the plugin-host is unreachable and no
   * fresh snapshot exists. `null` makes the decorator fail closed for
   * bucketed accounts (never a native fallback).
   */
  async routeSnapshot(): Promise<PluginRoutesWire | null> {
    const now = this.options.nowMs();
    if (this.routeCache !== null && now - this.routeCache.at <= this.options.cacheTtlMs) {
      return this.routeCache.routes;
    }
    try {
      const response = await this.options.fetch(`${this.options.baseUrl}/v1/plugin-routes`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.options.internalToken}` },
      });
      if (response.status !== 200) throw new Error(`plugin-routes returned ${response.status}`);
      const parsed = (await response.json()) as { routes?: PluginRoutesWire };
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.routes !== 'object') {
        throw new Error('plugin-routes response is malformed');
      }
      this.routeCache = { at: now, routes: parsed.routes };
      return parsed.routes;
    } catch {
      // Stale-but-recent snapshots are still authoritative enough for a
      // 1s-granularity routing decision; total blindness returns null.
      if (this.routeCache !== null && now - this.routeCache.at <= this.options.cacheTtlMs * 5) {
        return this.routeCache.routes;
      }
      return null;
    }
  }

  /** Stream one forward through the plugin-host. Throws PluginTransportError. */
  async forward(wire: PluginForwardRequestWire, signal: AbortSignal): Promise<PluginForwardResponse> {
    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.baseUrl}/v1/plugin-forward`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.internalToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(wire),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new PluginTransportError('CLIENT_ABORTED', 'the plugin forward was aborted', true);
      }
      throw new PluginTransportError(
        'PLUGIN_HOST_UNREACHABLE',
        error instanceof Error ? error.message : 'plugin-host is unreachable',
        false,
      );
    }
    if (response.status !== 200) {
      let requestSent = true; // conservative default
      let code = 'PLUGIN_HOST_ERROR';
      let message = 'the plugin-host forward failed';
      try {
        const parsed = (await response.json()) as { code?: unknown; message?: unknown; request_sent?: unknown };
        if (typeof parsed.code === 'string') code = parsed.code;
        if (typeof parsed.message === 'string') message = parsed.message;
        if (parsed.request_sent === false) requestSent = false;
      } catch {
        // keep defaults
      }
      throw new PluginTransportError(code, message, requestSent);
    }
    const statusHeader = response.headers.get('x-mr-plugin-status');
    const status = statusHeader === null ? null : Number.parseInt(statusHeader, 10);
    if (status === null || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new PluginTransportError('PLUGIN_INVALID_RESPONSE', 'the plugin-host returned an invalid status', true);
    }
    const headersHeader = response.headers.get('x-mr-plugin-headers');
    let headers: Record<string, readonly string[]> = {};
    if (headersHeader !== null) {
      try {
        const decoded = JSON.parse(Buffer.from(headersHeader, 'base64').toString('utf8')) as unknown;
        if (
          typeof decoded === 'object' &&
          decoded !== null &&
          !Array.isArray(decoded) &&
          Object.values(decoded).every((values) => Array.isArray(values))
        ) {
          headers = decoded as Record<string, readonly string[]>;
        }
      } catch {
        // empty headers is acceptable
      }
    }
    return { status, headers, body: response.body };
  }
}

export interface PluginForwardResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface PluginRoutingTransportOptions {
  /** The native claude prepared-evidence transport (the passthrough path). */
  readonly inner: PreparedEvidenceTransport;
  readonly capability: PluginCapabilityId;
  readonly routeReader: PluginRouteReader;
  readonly pluginHostClient: PluginHostClient;
  /** Pinned claude endpoint; the plugin may still rewrite the URL it dials. */
  readonly baseUrl: string;
  /**
   * Per-request claude identity context (CLI version override). The
   * composition cannot reach the inner transport's resolver (it is owned by
   * the runtime module), so the plugin path defaults to the pinned CLI
   * version; a future wiring may thread the real resolver through.
   */
  readonly resolveRequestContext?: (
    evidence: PreparedRequestEvidenceRecord,
  ) => Promise<ClaudeRequestIdentityContext> | ClaudeRequestIdentityContext;
}

/**
 * The optional claude-exit plugin routing layer. When no binding matches,
 * every call is a direct delegate to the inner transport.
 */
export class PluginRoutingClaudeTransport implements PreparedEvidenceTransport {
  private readonly options: PluginRoutingTransportOptions;

  constructor(options: PluginRoutingTransportOptions) {
    this.options = options;
  }

  async send(input: PreparedEvidenceTransportRequest): Promise<PreparedEvidenceTransportResponse> {
    const binding = await this.options.routeReader.enabledBinding(this.options.capability);
    if (binding === null || !accountInPluginRollout(input.evidence.accountId, binding.rolloutPercent)) {
      return this.options.inner.send(input);
    }
    const snapshot = await this.options.pluginHostClient.routeSnapshot();
    const route = snapshot?.[this.options.capability];
    if (snapshot === null || route === undefined || !route.available || route.plugin_key !== binding.pluginKey) {
      // Enabled binding + bucketed account + no serving plugin → fail
      // closed with a clean, metered 502. NO native fallback.
      return {
        responseStarted: false,
        resultHttpStatus: 502,
        upstreamErrorKind: 'plugin_route_unavailable',
        headers: {},
        body: null,
      };
    }

    const evidence = input.evidence;
    const credentialVersion = Number.parseInt(evidence.credentialVersion, 10);
    if (!Number.isInteger(credentialVersion) || credentialVersion < 1) {
      return {
        responseStarted: false,
        resultHttpStatus: 502,
        upstreamErrorKind: 'plugin_route_invalid_account',
        headers: {},
        body: null,
      };
    }
    if (evidence.accountOwnerKind !== 'tenant' && evidence.accountOwnerKind !== 'platform') {
      return {
        responseStarted: false,
        resultHttpStatus: 502,
        upstreamErrorKind: 'plugin_route_invalid_account',
        headers: {},
        body: null,
      };
    }
    const payload = assertPayloadShape(input);
    const context = await (this.options.resolveRequestContext?.(evidence) ?? {
      proxyKeyId: null,
      cliVersionOverride: null,
    });
    const headerMap = buildClaudeOutboundHeadersSansAuth(new URL(this.options.baseUrl), context.cliVersionOverride);
    const headers: Record<string, readonly string[]> = {};
    for (const [name, value] of Object.entries(headerMap)) headers[name] = [value];

    const wire: PluginForwardRequestWire = {
      request_id: `${evidence.requestId}:${evidence.attemptId}`,
      capability: this.options.capability,
      account: {
        id: evidence.accountId,
        owner_kind: evidence.accountOwnerKind,
        tenant_id: evidence.accountOwnerKind === 'tenant' ? evidence.tenantId : null,
        credential_id: evidence.credentialId,
        credential_version: credentialVersion,
      },
      method: 'POST',
      url: this.options.baseUrl,
      headers,
      body_base64: Buffer.from(payload).toString('base64'),
    };

    let forward: PluginForwardResponse;
    try {
      forward = await this.options.pluginHostClient.forward(wire, input.signal);
    } catch (error) {
      if (error instanceof PluginTransportError) {
        if (!error.requestSent) {
          // Pre-send plugin failure: clean 502, no account health signal,
          // no replay question.
          return {
            responseStarted: false,
            resultHttpStatus: 502,
            upstreamErrorKind: 'plugin_transport_error',
            headers: {},
            body: null,
          };
        }
        // request_sent=true: rethrow — dispatch records an UNKNOWN outcome
        // (uncertain whether upstream executed) and never replays.
        throw error;
      }
      throw error;
    }

    // Same usage observation as the native path so settlement is identical.
    const watcher = new MessagesUsageWatcher();
    let observedUsage: ClaudeMessagesUsage | null = null;
    const body =
      forward.body === null
        ? null
        : forward.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                watcher.feed(chunk);
                if (watcher.observed !== null) observedUsage = watcher.observed;
                controller.enqueue(chunk);
              },
              flush() {
                if (watcher.observed !== null) observedUsage = watcher.observed;
              },
            }),
          );
    const flatHeaders: Record<string, string> = {};
    for (const [name, values] of Object.entries(forward.headers)) {
      flatHeaders[name] = values.join(', ');
    }
    return {
      responseStarted: false,
      resultHttpStatus: forward.status,
      headers: flatHeaders,
      body,
      get providerUsage() {
        return observedUsage === null ? null : claudeUsageToObservedUsage(observedUsage);
      },
    };
  }
}

function assertPayloadShape(input: PreparedEvidenceTransportRequest): Uint8Array {
  const evidence = input.evidence;
  if (!(input.payloadBytes instanceof Uint8Array)) {
    throw new PluginTransportError('PLUGIN_INVALID_REQUEST', 'payload bytes are invalid', false);
  }
  if (typeof evidence.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.payloadSha256)) {
    throw new PluginTransportError('PLUGIN_INVALID_REQUEST', 'payload digest is invalid', false);
  }
  const actual = createHash('sha256').update(input.payloadBytes).digest();
  const expected = Buffer.from(evidence.payloadSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PluginTransportError('PLUGIN_INVALID_REQUEST', 'payload bytes do not match prepared evidence', false);
  }
  return input.payloadBytes;
}
