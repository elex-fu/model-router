import type { AuthenticatedApiKey } from '../../keys/types.js';
import { parseVideoCreateSnapshot } from './video-billing.js';
import type { VideoSettlementFacts } from './video-settlement-port.js';
import type { SaasVideoTaskStore } from './video-task-store.js';

/**
 * Roadmap batch 4 §4.3 (task #17): the create-time persistence port.
 *
 * Architectural decision (written down per the task brief): the video
 * create endpoint is a **synchronous forward through the ordinary
 * prepared-evidence pipeline** — the upstream itself is an asynchronous
 * task API that answers the create with a request id, so the gateway
 * holds the per-unit admission envelope, forwards, and returns the
 * upstream JSON verbatim. It deliberately does NOT run the #16
 * async-media-port background dispatch: there is no gateway-side task to
 * execute; the upstream owns the rendering. What the gateway must own is
 * the create-time snapshot: the billing identity (model / resolution /
 * duration / count — the completed status never echoes the resolution),
 * the bound account, and the frozen settlement facts for the deferred
 * status-poll settlement (migration 124's row).
 *
 * The handler calls `registerCreate` after a delivered 2xx create whose
 * body carries a request id; persistence failures never fail the already
 * delivered response — the task simply never becomes pollable and the
 * billing path fails closed later (the caller alerts).
 */

/** The 24 h TTL on the snapshot + binding (the sub2api pending-billing TTL). */
export const VIDEO_TASK_TTL_MS = 24 * 60 * 60 * 1000;

export interface SaasGatewayVideoCreatePort {
  registerCreate(input: {
    readonly authenticatedCaller: AuthenticatedApiKey;
    /** The upstream request id the create response carried. */
    readonly taskId: string;
    /** The account that accepted the create (the later polls' binding). */
    readonly account: {
      readonly accountId: string;
      readonly credentialId: string;
      readonly credentialVersion: string;
    };
    /** The create's gateway identity (the deferred settlement anchor). */
    readonly settlement: {
      readonly requestId: string;
      readonly attemptId: string;
    };
    /** The create request body (snapshot source: model/resolution/duration/n). */
    readonly requestBody: Record<string, unknown>;
    /** Frozen admission settlement facts; null for BYOK supply. */
    readonly settlementFacts: VideoSettlementFacts | null;
  }): Promise<void>;
}

export interface PersistentSaasGatewayVideoCreatePortOptions {
  readonly store: SaasVideoTaskStore;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class PersistentSaasGatewayVideoCreatePort implements SaasGatewayVideoCreatePort {
  private readonly store: SaasVideoTaskStore;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PersistentSaasGatewayVideoCreatePortOptions) {
    if (!options?.store) throw new Error('the video create port requires a task store');
    const ttlMs = options.ttlMs ?? VIDEO_TASK_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error('the video create port requires a positive TTL');
    }
    this.store = options.store;
    this.ttlMs = ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  async registerCreate(input: Parameters<SaasGatewayVideoCreatePort['registerCreate']>[0]): Promise<void> {
    const caller = input.authenticatedCaller;
    if (
      !caller ||
      typeof caller !== 'object' ||
      typeof caller.metadata?.tenantId !== 'string' ||
      typeof caller.metadata?.id !== 'string'
    ) {
      throw new Error('the video create caller is unauthenticated');
    }
    const snapshot = parseVideoCreateSnapshot(input.requestBody);
    const now = this.now();
    await this.store.create({
      requestId: input.taskId,
      tenantId: caller.metadata.tenantId,
      proxyKeyId: caller.metadata.id,
      providerAccountId: input.account.accountId,
      credentialId: input.account.credentialId,
      credentialVersion: input.account.credentialVersion,
      gatewayRequestId: input.settlement.requestId,
      gatewayAttemptId: input.settlement.attemptId,
      model: snapshot.model,
      resolution: snapshot.resolution,
      durationSeconds: snapshot.durationSeconds,
      videoCount: snapshot.videoCount,
      settlementFacts: input.settlementFacts,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    });
  }
}
