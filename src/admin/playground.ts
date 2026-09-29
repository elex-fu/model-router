import { randomUUID } from 'node:crypto';
import type { ConfigV2 } from '../config/v2-schema.js';
import { ControlError, type ControlService } from '../control/service.js';
import type { ControlStore } from '../control/store.js';
import type { SQLiteQuotaLedger } from '../quota/ledger.js';
import { quotaPeriod } from '../quota/period.js';
import type { QuotaTimezoneVersions } from '../quota/timezone-versions.js';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord } from '../telemetry/types.js';
import type { UpstreamActions } from './upstream-actions.js';

export interface PlaygroundInput {
  keyId: string;
  model: string;
  protocol: 'openai' | 'anthropic' | 'responses';
  input: string;
  maxOutputTokens: number;
  temperature?: number;
  stream?: boolean;
}
export interface PlaygroundExecution {
  output: string;
  status: number;
  upstreamId: string;
  model: string;
  durationMs: number;
  usage: AttemptRecord['usage'];
  error?: string | null;
}
/** Optional core-runtime executor for cross-protocol bridging and runtime quota semantics. */
export type PlaygroundExecutor = (
  input: PlaygroundInput & {
    actor: string;
    routeId: string;
    target: { upstreamId: string; model: string };
    source: 'playground';
    signal: AbortSignal;
  },
) => Promise<PlaygroundExecution>;

export class PlaygroundRuns {
  private active = new Map<string, { actor: string; controller: AbortController }>();
  constructor(
    private readonly control: ControlService,
    private readonly store: ControlStore,
    private readonly actions: UpstreamActions,
    private readonly telemetry?: SQLiteTelemetryStore,
    private readonly ledger?: SQLiteQuotaLedger,
    private readonly execute?: PlaygroundExecutor,
    private readonly quotaTimezoneVersions?: Pick<QuotaTimezoneVersions, 'resolveForAdmission'>,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS admin_playground_runs (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, key_id TEXT NOT NULL, model TEXT NOT NULL,
      protocol TEXT NOT NULL, route_id TEXT NOT NULL, upstream_id TEXT NOT NULL,
      state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, http_status INTEGER
    )`);
    store.db
      .prepare("UPDATE admin_playground_runs SET state='interrupted',ended_at=? WHERE state='running'")
      .run(new Date().toISOString());
  }

  private validate(input: Record<string, unknown>, config: ConfigV2): PlaygroundInput {
    const keyId = input.keyId,
      model = input.model,
      protocol = input.protocol,
      prompt = input.input;
    if (
      typeof keyId !== 'string' ||
      typeof model !== 'string' ||
      !['openai', 'anthropic', 'responses'].includes(String(protocol)) ||
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      prompt.length > 16_000
    )
      throw new ControlError(400, 'INVALID_PLAYGROUND_INPUT', 'Valid keyId, model, protocol and input are required');
    const key = config.proxyKeys.find((item) => item.id === keyId);
    if (!key || !key.enabled || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()))
      throw new ControlError(403, 'TEST_KEY_UNAVAILABLE', 'Select an enabled, unexpired proxy key for testing');
    if (key.allowedModels && !key.allowedModels.includes(model))
      throw new ControlError(403, 'TEST_KEY_MODEL_DENIED', 'Selected key does not allow this model');
    const maxOutputTokens = input.maxOutputTokens === undefined ? 256 : Number(input.maxOutputTokens);
    const temperature = input.temperature === undefined ? undefined : Number(input.temperature);
    if (
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 1024 ||
      (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2))
    )
      throw new ControlError(400, 'INVALID_PLAYGROUND_LIMIT', 'Invalid output token limit or temperature');
    return {
      keyId,
      model,
      protocol: protocol as PlaygroundInput['protocol'],
      input: prompt,
      maxOutputTokens,
      temperature,
      stream: input.stream === true,
    };
  }

  async run(input: Record<string, unknown>, actor: string, onStart?: (runId: string) => void) {
    if (this.active.size >= 4) throw new ControlError(429, 'TOO_MANY_RUNS', 'Too many playground runs');
    const config = await this.control.raw();
    const request = this.validate(input, config);
    const preview = await this.control.previewRoute(request.model, request.protocol);
    if (!preview.matched || !preview.candidates?.length)
      throw new ControlError(422, 'ROUTE_UNAVAILABLE', 'No configured route supports this model and protocol');
    const key = config.proxyKeys.find((item) => item.id === request.keyId);
    if (!key) throw new ControlError(403, 'TEST_KEY_UNAVAILABLE', 'Selected proxy key is unavailable');
    const candidate = preview.candidates.find(
      (item) =>
        item.configured &&
        (!key.allowedUpstreamIds || key.allowedUpstreamIds.includes(item.upstreamId)) &&
        (item.protocol === request.protocol || this.execute),
    );
    if (!candidate || !preview.routeId)
      throw new ControlError(
        422,
        'TARGET_UNAVAILABLE',
        'No allowed native target; cross-protocol targets require a core executor',
      );
    const ledger = this.execute ? undefined : this.ledger;
    if (!this.execute && (!this.telemetry || !ledger))
      throw new ControlError(
        503,
        'PLAYGROUND_QUOTA_UNAVAILABLE',
        'Direct playground requires telemetry and quota ledger, or a core executor',
      );
    const runId = `run_${randomUUID()}`;
    const controller = new AbortController();
    const started = Date.now();
    if (ledger) {
      const admissionAtMs = Date.now();
      const versionedPeriod = this.quotaTimezoneVersions?.resolveForAdmission(admissionAtMs);
      const period = versionedPeriod ?? quotaPeriod(admissionAtMs, config.quota.timezone);
      const decision = await ledger.admit({
        requestId: runId,
        proxyKeyId: request.keyId,
        atMs: admissionAtMs,
        periodId: period.id,
        periodStartMs: period.startMs,
        periodEndMs: period.endMs,
        timezoneVersionId: versionedPeriod?.versionId,
        reserveTokens: request.maxOutputTokens,
        dailyTokens: key.dailyTokens,
        rpm: key.rpm,
        maxConcurrentRequests: key.maxConcurrentRequests ?? config.quota.defaultMaxConcurrentRequests,
      });
      if (!decision.allowed)
        throw new ControlError(
          429,
          'PLAYGROUND_QUOTA_EXCEEDED',
          'Selected test key quota does not allow this run',
          decision,
        );
    }
    this.active.set(runId, { actor, controller });
    this.store.db
      .prepare('INSERT INTO admin_playground_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        runId,
        actor,
        request.keyId,
        request.model,
        request.protocol,
        preview.routeId,
        candidate.upstreamId,
        'running',
        new Date(started).toISOString(),
        null,
        null,
      );
    this.store.audit(actor, 'playground.run', { runId, keyId: request.keyId, routeId: preview.routeId });
    const telemetryRecord: RequestRecord = {
      id: runId,
      proxyKeyId: request.keyId,
      source: 'playground',
      clientProtocol: request.protocol,
      requestModel: request.model,
      routeId: preview.routeId,
      configRevision: config.revision,
      state: 'connecting',
      finalHttpStatus: null,
      startedAtMs: started,
      endedAtMs: null,
      durationMs: null,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: candidate.upstreamId,
    };
    try {
      // The core executor owns its own request/attempt accounting; direct fallback records here.
      if (!this.execute) await this.telemetry?.upsertRequest(telemetryRecord);
      onStart?.(runId);
      if (ledger) await ledger.markAttemptSent(runId);
      const value = this.execute
        ? await this.execute({
            ...request,
            actor,
            routeId: preview.routeId,
            target: { upstreamId: candidate.upstreamId, model: candidate.model },
            source: 'playground',
            signal: controller.signal,
          })
        : await this.actions.generate(
            candidate.upstreamId,
            candidate.model,
            request.input,
            request.maxOutputTokens,
            request.temperature,
            controller.signal,
          );
      const ended = Date.now();
      const state = controller.signal.aborted
        ? 'cancelled'
        : value.status >= 200 && value.status < 300
          ? 'completed'
          : 'failed';
      this.finish(runId, state, value.status, value.upstreamId || undefined);
      if (!this.execute) {
        const counted =
          value.usage?.inputTotal !== null &&
          value.usage?.outputTotal !== null &&
          value.usage?.inputTotal !== undefined &&
          value.usage?.outputTotal !== undefined
            ? value.usage.inputTotal + value.usage.outputTotal
            : null;
        if (ledger) await ledger.settle(runId, counted);
        await this.telemetry?.upsertRequest({
          ...telemetryRecord,
          state,
          finalHttpStatus: value.status,
          endedAtMs: ended,
          durationMs: ended - started,
        });
        await this.telemetry?.upsertAttempt({
          id: `${runId}_1`,
          requestId: runId,
          ordinal: 1,
          upstreamId: candidate.upstreamId,
          credentialId: null,
          resolvedModel: candidate.model,
          reportedModel: value.model,
          protocol: request.protocol,
          outcome: state,
          status: value.status,
          retryReason: value.error ?? null,
          startedAtMs: started,
          endedAtMs: ended,
          usage: value.usage,
          pricingVersion: null,
          costMicros: null,
          currency: null,
        });
      }
      return {
        runId,
        output: state === 'completed' ? value.output : '',
        summary: {
          state,
          status: value.status,
          routeId: preview.routeId,
          upstreamId: value.upstreamId || candidate.upstreamId,
          model: value.model || candidate.model,
          durationMs: ended - started,
          usage: value.usage,
          ...(value.error ? { error: value.error } : {}),
        },
      };
    } catch (error) {
      const ended = Date.now();
      const state = controller.signal.aborted ? 'cancelled' : 'failed';
      this.finish(runId, state, null);
      if (!this.execute)
        await this.telemetry?.upsertRequest({
          ...telemetryRecord,
          state,
          endedAtMs: ended,
          durationMs: ended - started,
        });
      throw error;
    } finally {
      if (ledger) await ledger.settle(runId, null);
      this.active.delete(runId);
    }
  }

  cancel(id: string, actor: string) {
    const row = this.store.db
      .prepare('SELECT actor_id AS actorId,state FROM admin_playground_runs WHERE id=?')
      .get(id) as { actorId: string; state: string } | undefined;
    if (!row) throw new ControlError(404, 'NOT_FOUND', 'Run not found');
    if (row.actorId !== actor) throw new ControlError(403, 'FORBIDDEN', 'Run belongs to another user');
    this.active.get(id)?.controller.abort();
    if (row.state === 'running') this.finish(id, 'cancelled', null);
    this.store.audit(actor, 'playground.cancel', { runId: id });
    return this.get(id);
  }
  get(id: string) {
    const row = this.store.db
      .prepare(
        'SELECT id,key_id AS keyId,model,protocol,route_id AS routeId,upstream_id AS upstreamId,state,started_at AS startedAt,ended_at AS endedAt,http_status AS status FROM admin_playground_runs WHERE id=?',
      )
      .get(id);
    if (!row) throw new ControlError(404, 'NOT_FOUND', 'Run not found');
    return row;
  }
  /** Secret- and prompt-safe aggregate used by the setup guide's completion state. */
  completionStatus() {
    const row = this.store.db
      .prepare(
        "SELECT COUNT(*) AS successfulRuns, MAX(ended_at) AS lastSuccessfulAt FROM admin_playground_runs WHERE state='completed'",
      )
      .get() as { successfulRuns: number; lastSuccessfulAt: string | null };
    return {
      completed: row.successfulRuns > 0,
      successfulRuns: row.successfulRuns,
      lastSuccessfulAt: row.lastSuccessfulAt,
    };
  }
  close() {
    for (const item of this.active.values()) item.controller.abort();
  }
  private finish(id: string, state: string, status: number | null, upstreamId?: string) {
    this.store.db
      .prepare(
        'UPDATE admin_playground_runs SET state=?,ended_at=?,http_status=?,upstream_id=COALESCE(?,upstream_id) WHERE id=? AND state=?',
      )
      .run(state, new Date().toISOString(), status, upstreamId ?? null, id, 'running');
  }
}
