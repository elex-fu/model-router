import type { Config, Protocol } from '../config/types.js';
import type { ConfigV2 } from '../config/v2-schema.js';
import { ControlError, type ControlService } from '../control/service.js';
import { pickBridge } from '../protocol/bridge.js';
import { resolveRoute } from '../router/routes.js';
import type { CircuitBreaker } from '../server/circuitBreaker.js';
import type { KeyPool } from '../server/keyPool.js';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';

export function previewRuntimeRoute(input: {
  model: string;
  protocol: Protocol;
  proxyKeyId?: string;
  snapshot: Config;
  raw: ConfigV2;
  keyPool: Pick<KeyPool, 'getAvailableCount'>;
  circuitBreaker: Pick<CircuitBreaker, 'status'>;
  healthStatus: (upstreamId: string) => { healthy: boolean; checkedAt: number; error?: string } | undefined;
}) {
  const { model, protocol, snapshot, raw, keyPool, circuitBreaker, healthStatus } = input;
  const resolved = resolveRoute(model, protocol, {
    routes: snapshot.routes ?? [],
    upstreams: snapshot.upstreams.map((item) => ({ ...item, id: item.id ?? item.name })),
  });
  if (!resolved.route)
    return {
      matched: false,
      reason: 'model_not_found',
      candidates: [],
      runtime: true,
      proxyKey: input.proxyKeyId ? 'unavailable' : 'not_selected',
    };
  if (resolved.reason)
    return {
      matched: false,
      reason: resolved.reason,
      routeId: resolved.route.id,
      candidates: [],
      runtime: true,
      proxyKey: input.proxyKeyId ? 'unavailable' : 'not_selected',
    };

  const proxyKey = input.proxyKeyId ? snapshot.proxyKeys.find((item) => item.id === input.proxyKeyId) : undefined;
  const keyState = !input.proxyKeyId
    ? 'not_selected'
    : !proxyKey?.enabled || (proxyKey.expiresAt ? Date.parse(proxyKey.expiresAt) <= Date.now() : false)
      ? 'unavailable'
      : 'selected';
  const authorizedKey = keyState === 'selected' ? proxyKey : undefined;
  const matches = (pattern: string) =>
    pattern === model ||
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(model);
  const modelAllowed = !authorizedKey?.allowedModels?.length || authorizedKey.allowedModels.some(matches);
  const candidates = resolved.route.targets.map((target, order) => {
    const upstream = snapshot.upstreams.find((item) => item.id === target.upstreamId);
    const rawUpstream = raw.upstreams.find((item) => item.id === target.upstreamId);
    const rawModel = rawUpstream?.models.find((item) => item.id === target.model);
    const health = healthStatus(target.upstreamId);
    const circuit = circuitBreaker.status(target.upstreamId);
    const availableCredentials = keyPool.getAvailableCount(upstream?.name ?? target.upstreamId);
    const configuredCredentials = upstream?.apiKeys.length ?? 0;
    let bridge: 'native' | 'bridge' | 'unsupported' = 'unsupported';
    if (upstream) {
      try {
        pickBridge(protocol, upstream.protocol);
        bridge = protocol === upstream.protocol ? 'native' : 'bridge';
      } catch {
        /* Unsupported pairs remain visible as excluded candidates. */
      }
    }
    const allowedUpstream =
      !authorizedKey ||
      ((!authorizedKey.allowedUpstreamIds?.length || authorizedKey.allowedUpstreamIds.includes(target.upstreamId)) &&
        (!authorizedKey.allowedUpstreams?.length ||
          authorizedKey.allowedUpstreams.includes(target.upstreamId) ||
          authorizedKey.allowedUpstreams.includes(upstream?.name ?? '')));
    const exclusionReason =
      input.proxyKeyId && keyState !== 'selected'
        ? 'proxy_key_unavailable'
        : !modelAllowed
          ? 'key_model_denied'
          : !upstream
            ? 'upstream_missing'
            : !upstream.enabled
              ? 'upstream_disabled'
              : !rawModel
                ? 'model_missing'
                : !rawModel.enabled
                  ? 'model_disabled'
                  : !allowedUpstream
                    ? 'key_upstream_denied'
                    : bridge === 'unsupported'
                      ? 'unsupported_bridge'
                      : configuredCredentials === 0 && !['none', 'pass-through'].includes(upstream.authMode ?? 'bearer')
                        ? 'no_credentials'
                        : availableCredentials === 0 && configuredCredentials > 0
                          ? 'credentials_cooling_down'
                          : circuit.state === 'open'
                            ? 'circuit_open'
                            : health?.healthy === false
                              ? 'health_unhealthy'
                              : undefined;
    const eligible = exclusionReason === undefined && circuit.state !== 'half-open';
    return {
      ...target,
      order,
      actualModel: target.model,
      upstreamProtocol: upstream?.protocol ?? null,
      protocol: upstream?.protocol ?? null,
      bridge,
      configured: Boolean(upstream?.enabled && rawModel?.enabled),
      credentialState:
        upstream?.authMode === 'none' || upstream?.authMode === 'pass-through'
          ? 'not_required'
          : configuredCredentials === 0
            ? 'missing'
            : availableCredentials === 0
              ? 'cooling_down'
              : 'available',
      configuredCredentials,
      availableCredentials,
      circuitState: circuit.state,
      healthStatus: health ? (health.healthy ? 'healthy' : 'unhealthy') : 'unknown',
      healthCheckedAt: health?.checkedAt ?? null,
      healthError: health?.error ?? null,
      upstreamEnabled: upstream?.enabled ?? false,
      modelEnabled: rawModel?.enabled ?? false,
      modelConfigured: Boolean(rawModel),
      eligible,
      selected: false,
      availability: exclusionReason
        ? 'unavailable'
        : circuit.state === 'half-open' || !health
          ? 'uncertain'
          : 'available',
      exclusionReason: exclusionReason ?? (circuit.state === 'half-open' ? 'circuit_half_open' : undefined),
    };
  });
  let selected = false;
  let selectionUncertain = false;
  for (const candidate of candidates) {
    if (candidate.circuitState === 'half-open') {
      selectionUncertain = true;
      candidate.availability = 'uncertain';
      candidate.exclusionReason = 'circuit_half_open';
      break;
    }
    if (candidate.eligible && !selected) {
      candidate.selected = true;
      selected = true;
      break;
    }
    candidate.selected = false;
  }
  return {
    matched: true,
    routeId: resolved.route.id,
    runtime: true,
    proxyKey: keyState,
    selection: selectionUncertain ? 'uncertain' : selected ? 'selected' : 'none_eligible',
    candidates,
  };
}

/** Inject live runtime objects from server/index; no independent/fake breaker is created. */
export interface AdminRuntimeBridge {
  previewRoute?(input: { model: string; protocol: Protocol; proxyKeyId?: string }): Promise<unknown> | unknown;
  getUpstreamStatus?(upstreamId: string): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  listHealthEvents?(upstreamId: string, limit: number): Promise<unknown[]> | unknown[];
  resetCircuit(upstreamId: string): Promise<void> | void;
}

export class AdminRuntime {
  constructor(
    private readonly control: ControlService,
    private readonly telemetry?: SQLiteTelemetryStore,
    private readonly bridge?: AdminRuntimeBridge,
  ) {}

  async previewRoute(model: string, protocol: string, proxyKeyId?: string) {
    if (!['openai', 'anthropic', 'responses'].includes(protocol))
      throw new ControlError(422, 'UNSUPPORTED_CLIENT_PROTOCOL', 'Unsupported client protocol');
    if (this.bridge?.previewRoute)
      return this.bridge.previewRoute({ model, protocol: protocol as Protocol, proxyKeyId });
    const preview = await this.control.previewRoute(model, protocol);
    return {
      ...preview,
      runtime: false,
      proxyKey: proxyKeyId ? 'unverified' : 'not_selected',
      candidates: preview.candidates.map((candidate, order) => ({
        ...candidate,
        order,
        actualModel: candidate.model,
        upstreamProtocol: candidate.protocol ?? null,
        bridge: candidate.bridge === 'native' ? 'native' : candidate.bridge === 'bridge' ? 'bridge' : 'unsupported',
        eligible: candidate.configured === true,
        selected: order === 0 && candidate.configured === true,
        exclusionReason: candidate.configured === true ? undefined : 'config_unavailable',
      })),
    };
  }

  async snapshot(upstreamId: string) {
    const upstream = (await this.control.raw()).upstreams.find((item) => item.id === upstreamId);
    if (!upstream) throw new ControlError(404, 'NOT_FOUND', 'Upstream not found');
    const status = await this.bridge?.getUpstreamStatus?.(upstreamId);
    const last = this.telemetry?.connection
      .prepare(`SELECT a.outcome,a.status,a.started_at_ms AS startedAtMs,
      a.ended_at_ms AS endedAtMs FROM attempts a WHERE a.upstream_id=? ORDER BY a.started_at_ms DESC LIMIT 1`)
      .get(upstreamId) as
      | { outcome: string; status: number | null; startedAtMs: number; endedAtMs: number | null }
      | undefined;
    return {
      upstreamId,
      configEnabled: upstream.enabled,
      availableCredentials: upstream.credentials.filter(
        (item) => item.enabled && this.control.store.secrets.status(item.secret).configured,
      ).length,
      healthStatus:
        status?.healthStatus ?? (last ? (last.outcome === 'completed' ? 'healthy' : 'unhealthy') : 'unknown'),
      circuitState: status?.circuitState ?? 'unknown',
      lastAttempt: last
        ? {
            outcome: last.outcome,
            status: last.status,
            startedAt: new Date(last.startedAtMs).toISOString(),
            endedAt: last.endedAtMs ? new Date(last.endedAtMs).toISOString() : null,
          }
        : null,
      ...status,
    };
  }

  async events(upstreamId: string, limit = 50) {
    await this.snapshot(upstreamId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new ControlError(400, 'INVALID_LIMIT', 'Limit must be 1–200');
    if (this.bridge?.listHealthEvents) return this.bridge.listHealthEvents(upstreamId, limit);
    if (!this.telemetry) throw new ControlError(503, 'HEALTH_HISTORY_UNAVAILABLE', 'Telemetry store is required');
    const rows = this.telemetry.connection
      .prepare(`SELECT a.id,a.request_id AS requestId,a.outcome,
      a.status,a.started_at_ms AS startedAtMs,a.ended_at_ms AS endedAtMs,r.source
      FROM attempts a JOIN requests r ON r.id=a.request_id WHERE a.upstream_id=?
      ORDER BY a.started_at_ms DESC LIMIT ?`)
      .all(upstreamId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      startedAt: new Date(Number(row.startedAtMs)).toISOString(),
      endedAt: row.endedAtMs === null ? null : new Date(Number(row.endedAtMs)).toISOString(),
    }));
  }

  async reset(upstreamId: string) {
    await this.snapshot(upstreamId);
    if (!this.bridge)
      throw new ControlError(503, 'CIRCUIT_CONTROL_UNAVAILABLE', 'Live circuit control is not injected');
    await this.bridge.resetCircuit(upstreamId);
    return { upstreamId, circuitState: 'closed', resetAt: new Date().toISOString() };
  }
}
