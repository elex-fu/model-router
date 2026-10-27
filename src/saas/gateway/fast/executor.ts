import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AuthenticatedApiKey } from '../../keys/types.js';
import type { CustomerPriceVersionRecord } from '../../pricing/types.js';
import type { GatewayProviderCredentialUnsealer } from '../../runtime/gateway-provider-credential-unsealer.js';
import type { ClientAddressResolution } from '../client-address.js';
import { createModelResolutionProvenance } from '../contracts.js';
import { calculateConservativePriceHold, INPUT_BILLING_BUCKETS } from '../hold-calculator.js';
import type {
  PreparedEvidenceClientStream,
  PreparedEvidenceTransportResponse,
} from '../prepared-evidence-dispatch-service.js';
import {
  type ProviderHttpBoundRequest,
  ProviderHttpTransport,
  type ProviderHttpTransportOptions,
} from '../provider-http-transport.js';
import { observeRequestDiagnosticPhase } from '../request-diagnostic-trace.js';
import type { RequestPreparationPayloadCompiler } from '../request-preparation-service.js';
import { calculateFastReceiptCharge, type FastPriceSnapshot } from './journal.js';
import type { FastReceiptQueue } from './receipt-queue.js';
import type { FastGatewayAdmission } from './redis-admission.js';
import {
  authorizeFastGatewaySnapshot,
  type FastGatewayCandidate,
  type FastGatewaySnapshotProvider,
} from './snapshots.js';
import { FastTerminalGate } from './terminal-gate.js';
import { fastTextRequestUnsupported } from './text-eligibility.js';

export interface FastIntentInput {
  readonly requestId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly requestFingerprint: string;
  readonly payloadSha256: string;
  readonly accountId: string;
  readonly currency: string | null;
  readonly maxCostMinorUnits: string;
  readonly priceSnapshot: unknown;
  readonly authoritySnapshot: unknown;
  readonly allocationOwner: string;
  readonly allocationTargetConcurrency?: number;
  readonly sendDeadlineMs: number;
  readonly signal?: AbortSignal;
}
export interface FastReceiptInput {
  readonly intentId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  readonly chargeMinorUnits: string | null;
  readonly usage: Readonly<Record<string, string | null>>;
  readonly usageDigest: string;
  readonly httpStatus: number | null;
  /** Internal frozen intent price, never client-supplied evidence. */
  readonly verification?: { readonly priceSnapshot: FastPriceSnapshot };
}
export interface FastGatewayJournalPort {
  reserveIntent(
    input: FastIntentInput,
  ): Promise<
    | { readonly kind: 'created'; readonly intent: { readonly id: string } }
    | { readonly kind: 'existing'; readonly requestId: string; readonly status: string }
    | { readonly kind: 'denied'; readonly reason: string }
  >;
  appendReceipt(input: FastReceiptInput): Promise<void>;
}
export interface FastGatewayExecuteInput {
  readonly requestId: string;
  readonly authenticatedCaller: AuthenticatedApiKey;
  readonly path: string;
  readonly publicModel: string;
  readonly protocol: string;
  readonly body: Record<string, unknown>;
  readonly clientAddress: ClientAddressResolution;
  readonly idempotencyKey?: string;
  readonly client: PreparedEvidenceClientStream;
  /** Nonsecret mode observability; called before any response headers. */
  readonly selected?: (mode: 'fast' | 'strict', reason: string) => void;
}
export interface FastGatewayExecutorPort {
  /** false is unsupported BEFORE intent only. Once intent exists, this always owns the request. */
  execute(input: FastGatewayExecuteInput): Promise<boolean>;
}
export class FastGatewayExecutionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'FastGatewayExecutionError';
  }
}
export interface FastGatewayExecutorOptions {
  readonly snapshots: FastGatewaySnapshotProvider;
  readonly admission: FastGatewayAdmission;
  readonly journal: FastGatewayJournalPort;
  /** Explicit opt-in only. Default preserves durable receipt acknowledgement before terminal. */
  readonly receiptQueue?: FastReceiptQueue;
  readonly payload: (candidate: FastGatewayCandidate) => RequestPreparationPayloadCompiler;
  readonly transport: Omit<ProviderHttpTransportOptions, 'resolveCredential' | 'consumeFastTicket'>;
  readonly unsealer: Pick<GatewayProviderCredentialUnsealer, 'withCredential'>;
  readonly allocationOwner: string;
  readonly maxLocalConcurrency?: number;
  readonly timeoutMs: number;
}
const usageKeys = [
  'inputTotal',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'outputTotal',
  'reasoningOutput',
] as const;
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function fallbackReason(input: FastGatewayExecuteInput): string | null {
  if (input.idempotencyKey !== undefined) return 'client_idempotency';
  if (input.path !== '/v1/chat/completions' || input.protocol !== 'openai') return 'operation';
  // The compiler may inject the server-enforced ceiling; the final body must
  // still contain a positive bound before Redis admission or a durable intent.
  return fastTextRequestUnsupported(input.body, { allowMissingOutputBound: true });
}
function pricingSupported(price: CustomerPriceVersionRecord): boolean {
  return price.tokenMultipliers === null && price.rates.per_unit === null && price.rates.per_unit_tiers === null;
}
function normalizedUsage(response: PreparedEvidenceTransportResponse): Record<string, string | null> {
  const usage = response.providerUsage;
  if (!usage) throw new Error('Provider usage missing');
  const result: Record<string, string | null> = {};
  for (const key of usageKeys) {
    const raw = usage[key];
    if (raw === null || raw === undefined) result[key] = null;
    else {
      const n = BigInt(raw);
      if (n < 0n) throw new Error('Invalid provider usage');
      result[key] = n.toString();
    }
  }
  if (result.inputTotal === null || result.outputTotal === null) throw new Error('Incomplete provider usage');
  return result;
}

/** A new data plane; no calls to legacy admission/evidence/lease/proof stores. */
export class FastGatewayExecutor implements FastGatewayExecutorPort {
  readonly #tickets = new WeakMap<object, { bound: ProviderHttpBoundRequest; validate: () => void }>();
  readonly #credentials = new AsyncLocalStorage<{
    candidate: FastGatewayCandidate;
    validate: () => Promise<void>;
  }>();
  readonly #transport: ProviderHttpTransport;
  readonly #options: FastGatewayExecutorOptions;
  constructor(options: FastGatewayExecutorOptions) {
    this.#options = options;
    this.#transport = new ProviderHttpTransport({
      ...options.transport,
      consumeFastTicket: (ticket) => {
        if (!ticket || typeof ticket !== 'object') throw new Error('Invalid fast dispatch ticket');
        const issued = this.#tickets.get(ticket);
        this.#tickets.delete(ticket);
        if (!issued) throw new Error('Unissued or consumed fast dispatch ticket');
        issued.validate();
        return issued.bound;
      },
      resolveCredential: async (input, useCredential) => {
        const context = this.#credentials.getStore();
        const candidate = context?.candidate;
        const a = candidate?.authority;
        if (
          !context ||
          !candidate ||
          !a ||
          input.accountId !== a.accountId ||
          input.credentialId !== a.credentialId ||
          input.credentialVersion !== String(a.credentialVersion) ||
          input.tenantId !== a.tenantId ||
          input.signal.aborted
        ) {
          throw new Error('Fast credential scope mismatch');
        }
        await context.validate();
        const header = candidate.dispatch?.authenticationHeader;
        const descriptor = header;
        if (
          !descriptor ||
          typeof descriptor.headerName !== 'string' ||
          !['authorization', 'api-key', 'x-api-key', 'x-goog-api-key'].includes(descriptor.headerName.toLowerCase()) ||
          ![undefined, 'raw', 'bearer'].includes(descriptor.valueFormat as string | undefined)
        )
          throw new Error('Fast credential header unavailable');
        return options.unsealer.withCredential(candidate.credential, async (plain) => {
          await context.validate();
          const bearer =
            descriptor.valueFormat === 'bearer' ||
            (descriptor.valueFormat === undefined &&
              (descriptor.headerName as string).toLowerCase() === 'authorization');
          const value = bearer ? Buffer.concat([Buffer.from('Bearer '), plain]) : Buffer.from(plain);
          try {
            return await useCredential({ headerName: descriptor.headerName as string, value });
          } finally {
            value.fill(0);
          }
        });
      },
    });
  }

  async execute(input: FastGatewayExecuteInput): Promise<boolean> {
    return this.#executeWithRefresh(input, 0);
  }

  async #executeWithRefresh(input: FastGatewayExecuteInput, refreshAttempts: number): Promise<boolean> {
    const unsupported = fallbackReason(input);
    if (unsupported) {
      input.selected?.('strict', unsupported);
      return false;
    }
    const snapshotInput = {
      authenticatedCaller: input.authenticatedCaller,
      publicModel: input.publicModel,
      protocol: 'openai' as const,
      clientOperation: 'chat.completions',
      clientAddress: input.clientAddress,
      inputByteLength: Buffer.byteLength(canonical(input.body)),
    };
    const snapshot = await observeRequestDiagnosticPhase('fast-snapshot', () =>
      this.#options.snapshots.resolve(snapshotInput),
    );
    if (!snapshot) {
      input.selected?.('strict', 'snapshot_policy');
      return false;
    }
    const deadline = performance.now() + Math.max(0, snapshot.validUntilMs - Date.now());
    const assertFresh = () => {
      if (performance.now() >= deadline || input.client.signal.aborted)
        throw new FastGatewayExecutionError(503, 'FAST_AUTHORITY_EXPIRED');
      authorizeFastGatewaySnapshot(snapshot, snapshotInput);
    };
    assertFresh();
    const candidate = snapshot.candidates[0];
    if (!candidate?.dispatch || (snapshot.authority.route.providerProtocol ?? 'openai') !== 'openai') {
      input.selected?.('strict', 'provider_protocol');
      return false;
    }
    // Capture before compilation/admission awaits. A provider implementation
    // may refresh or reuse its snapshot objects; that must never change the
    // maximum, durable intent price, final charge or compaction proof in flight.
    const price: CustomerPriceVersionRecord | null = candidate.customerPrice
      ? deepFreeze(JSON.parse(canonical(candidate.customerPrice)) as CustomerPriceVersionRecord)
      : null;
    if (candidate.authority.supplyMode === 'platform' && (!price || !pricingSupported(price))) {
      input.selected?.('strict', 'price_policy');
      return false;
    }
    const authority = { ...snapshot.authority, candidate: candidate.authority };
    const modelResolution =
      authority.modelResolution ??
      createModelResolutionProvenance(
        input.publicModel,
        candidate.authority.resolvedModel,
        authority.modelMappingRules,
      );
    const compiled = await observeRequestDiagnosticPhase('fast-compile', () =>
      this.#options.payload(candidate).compile({
        caller: snapshot.caller,
        entitlement: snapshot.entitlement,
        authority,
        clientRequest:
          input.body.stream === true
            ? {
                ...input.body,
                stream_options: {
                  ...(input.body.stream_options &&
                  typeof input.body.stream_options === 'object' &&
                  !Array.isArray(input.body.stream_options)
                    ? (input.body.stream_options as Record<string, unknown>)
                    : {}),
                  include_usage: true,
                },
              }
            : input.body,
        clientProtocol: 'openai',
        providerProtocol: 'openai',
        clientOperation: 'chat.completions',
        providerOperation: 'chat.completions',
        modelResolution,
      }),
    );
    if (compiled.decision !== 'allow') throw new FastGatewayExecutionError(400, 'FAST_PAYLOAD_REJECTED');
    const payload = compiled.value;
    let compiledBody: unknown;
    try {
      compiledBody = JSON.parse(Buffer.from(payload.payloadBytes).toString('utf8'));
    } catch {
      input.selected?.('strict', 'compiled_body');
      return false;
    }
    if (
      !compiledBody ||
      typeof compiledBody !== 'object' ||
      Array.isArray(compiledBody) ||
      fastTextRequestUnsupported(compiledBody as Record<string, unknown>)
    ) {
      input.selected?.('strict', 'compiled_fields');
      return false;
    }
    const compiledTextBody = compiledBody as Record<string, unknown>;
    if (
      compiledTextBody.stream === true &&
      (compiledTextBody.stream_options as Record<string, unknown> | undefined)?.include_usage !== true
    ) {
      input.selected?.('strict', 'compiled_stream_usage');
      return false;
    }
    if (
      payload.providerProtocol !== 'openai' ||
      payload.providerOperation !== 'chat.completions' ||
      payload.usage.perUnitUnitsUpperBound != null
    ) {
      input.selected?.('strict', 'compiled_operation');
      return false;
    }
    const maxInput = BigInt(payload.usage.inputTotalUpperBound);
    const maxOutput = BigInt(payload.usage.outputTotalUpperBound);
    if (maxInput < 0n || maxOutput <= 0n || maxInput + maxOutput > BigInt(Number.MAX_SAFE_INTEGER)) {
      input.selected?.('strict', 'usage_bound');
      return false;
    }
    const compiledOutputLimit = Math.max(
      Number((compiledBody as Record<string, unknown>).max_tokens ?? 0),
      Number((compiledBody as Record<string, unknown>).max_completion_tokens ?? 0),
    );
    if (BigInt(compiledOutputLimit) > maxOutput) {
      input.selected?.('strict', 'compiled_output_bound');
      return false;
    }
    let maxCost = 0n;
    if (price)
      maxCost = calculateConservativePriceHold(price, {
        inputUpperBound: maxInput,
        outputUpperBound: maxOutput,
        feasibleInputBuckets: INPUT_BILLING_BUCKETS,
      }).calculation.amountMinorUnits;
    // The initial priced journal requires a backed allocation. Free/rounded-zero
    // platform pricing stays strict instead of entering an unfundable auto target.
    if (price && maxCost === 0n) {
      input.selected?.('strict', 'zero_price');
      return false;
    }
    const priceSnapshot: FastPriceSnapshot | null = price
      ? Object.freeze({
          schemaVersion: 1,
          customerPrice: price,
          maxInputTokens: maxInput.toString(),
          maxOutputTokens: maxOutput.toString(),
        })
      : null;
    if (input.client.signal.aborted) throw new FastGatewayExecutionError(503, 'FAST_AUTHORITY_EXPIRED');
    const remainingValidity = () => Math.min(deadline - performance.now(), snapshot.validUntilMs - Date.now());
    if (remainingValidity() < 500) {
      // Compilation may have queued after snapshot resolution. Reload/recompile
      // only before Redis owns this request id; never release/reacquire a lease.
      if (refreshAttempts === 0) return this.#executeWithRefresh(input, 1);
      throw new FastGatewayExecutionError(503, 'FAST_AUTHORITY_EXPIRED');
    }
    assertFresh();
    if (this.#options.receiptQueue && !this.#options.receiptQueue.canAdmit())
      throw new FastGatewayExecutionError(503, 'FAST_RECEIPT_BACKPRESSURE');
    const admitted = await observeRequestDiagnosticPhase('fast-redis', () =>
      this.#options.admission.acquire({
        requestId: input.requestId,
        tenantId: snapshot.caller.tenantId,
        projectId: snapshot.caller.projectId,
        proxyKeyId: snapshot.caller.proxyKeyId,
        accountId: candidate.authority.accountId,
        accountOwnerScope: candidate.authority.accountOwnerKind === 'platform' ? 'platform' : snapshot.caller.tenantId,
        model: payload.resolvedModel,
        tokenUnits: Number(maxInput + maxOutput),
        ttlMs: this.#options.timeoutMs,
        ...(snapshot.limits.group ? { groupId: snapshot.limits.group.id } : {}),
        limits: {
          tenant: snapshot.limits.tenant,
          project: snapshot.limits.project,
          key: snapshot.limits.key,
          account: {
            ...candidate.limits,
            rpm: candidate.limits.rpm ?? undefined,
            tpm: candidate.limits.tpm ?? undefined,
          },
          ...(snapshot.limits.group?.rpm != null ? { group: { rpm: snapshot.limits.group.rpm } } : {}),
        },
      }),
    );
    if (!admitted.allowed)
      throw new FastGatewayExecutionError(
        admitted.reason === 'unavailable' ? 503 : 429,
        `FAST_${admitted.reason.toUpperCase()}`,
      );
    const lease = admitted.lease;
    let intentId: string | undefined;
    let receiptState: 'none' | 'captured' | 'queued' | 'durable' = 'none';
    let actualTokenUnits: number | undefined;
    let upstreamStarted = false;
    let upstreamComplete = false;
    let responseStatus: number | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatPending: Promise<void> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.client.signal.addEventListener('abort', abort, { once: true });
    let cleanupPromise: Promise<void> | undefined;
    // Both the successful terminal path and finally own the same cleanup. In
    // particular, a failed terminal write or uncertain release ACK must never
    // issue a second release or replace the already-owned receipt.
    const cleanupOperationalLease = (): Promise<void> =>
      (cleanupPromise ??= (async () => {
        if (heartbeat) clearInterval(heartbeat);
        if (heartbeatPending) await heartbeatPending;
        input.client.signal.removeEventListener('abort', abort);
        if (!upstreamStarted || upstreamComplete) {
          const feedback =
            responseStatus === undefined
              ? undefined
              : {
                  outcome:
                    responseStatus === 429
                      ? ('rate_limited' as const)
                      : responseStatus >= 500
                        ? ('failure' as const)
                        : ('success' as const),
                  ...(actualTokenUnits === undefined ? {} : { actualTokenUnits }),
                  ...(responseStatus === 429
                    ? { cooldownMs: 1000, modelOnly: true }
                    : responseStatus >= 500
                      ? { cooldownMs: 1000 }
                      : {}),
                };
          if (receiptState === 'queued' && lease.releaseConcurrency) {
            await lease.releaseConcurrency(feedback).catch(() => undefined);
          } else {
            await lease.release(feedback).catch(() => undefined);
          }
        }
      })());
    const attemptId = randomUUID();
    try {
      assertFresh();
      if (remainingValidity() < 250) throw new FastGatewayExecutionError(503, 'FAST_AUTHORITY_EXPIRED');
      const payloadSha256 = hash(payload.payloadBytes);
      const reserved = await observeRequestDiagnosticPhase('fast-intent', () =>
        this.#options.journal.reserveIntent({
          requestId: input.requestId,
          attemptId,
          tenantId: snapshot.caller.tenantId,
          projectId: snapshot.caller.projectId,
          proxyKeyId: snapshot.caller.proxyKeyId,
          requestFingerprint: hash(payload.requestFingerprint),
          payloadSha256,
          accountId: candidate.authority.accountId,
          currency: price?.currency ?? null,
          maxCostMinorUnits: maxCost.toString(),
          priceSnapshot,
          authoritySnapshot: JSON.parse(
            canonical({
              revision: snapshot.revision,
              principal: { kind: snapshot.caller.principalKind, id: snapshot.caller.principalId },
              authorizationVersions: {
                key: snapshot.caller.authzVersion,
                modelScope: snapshot.caller.modelScopeVersion,
                entitlement: snapshot.caller.entitlementVersion,
                supplyProfile: snapshot.caller.supplyProfileVersion,
                projectPolicy: snapshot.entitlement.projectPolicyVersion,
              },
              commercial: authority.commercial,
              modelResolution,
              candidate: candidate.authority,
              route: authority.route,
              compilerVersion: payload.compilerVersion,
              estimatorVersion: payload.estimatorVersion,
            }),
          ),
          allocationOwner: this.#options.allocationOwner,
          allocationTargetConcurrency: Math.min(
            1024,
            this.#options.maxLocalConcurrency ?? 1024,
            snapshot.limits.tenant.concurrency,
            snapshot.limits.project.concurrency,
            snapshot.limits.key.concurrency,
            candidate.limits.concurrency,
          ),
          sendDeadlineMs: snapshot.validUntilMs,
          signal: input.client.signal,
        }),
      );
      if (reserved.kind !== 'created') {
        if (reserved.kind === 'existing') throw new FastGatewayExecutionError(409, 'FAST_REQUEST_EXISTS');
        if (reserved.reason === 'send_deadline') throw new FastGatewayExecutionError(503, 'FAST_AUTHORITY_EXPIRED');
        if (reserved.reason === 'credit_busy') throw new FastGatewayExecutionError(503, 'FAST_CREDIT_BUSY');
        if (reserved.reason === 'closed') throw new FastGatewayExecutionError(503, 'FAST_JOURNAL_UNAVAILABLE');
        throw new FastGatewayExecutionError(
          429,
          reserved.reason === 'credit_not_ready' ? 'FAST_CREDIT_NOT_READY' : 'FAST_CREDIT_UNAVAILABLE',
        );
      }
      intentId = reserved.intent.id;
      input.selected?.('fast', 'reserved_max');
      assertFresh();
      if (!(await observeRequestDiagnosticPhase('fast-lease-check', () => lease.assertValid())))
        throw new FastGatewayExecutionError(503, 'FAST_LEASE_UNAVAILABLE');
      assertFresh();
      const bound: ProviderHttpBoundRequest = {
        tenantId: snapshot.caller.tenantId,
        projectId: snapshot.caller.projectId,
        requestId: input.requestId,
        attemptId,
        fencingToken: lease.fencingToken,
        signal: controller.signal,
        payloadBytes: payload.payloadBytes,
        clientOperation: 'chat.completions',
        evidence: {
          evidenceId: intentId,
          tenantId: snapshot.caller.tenantId,
          projectId: snapshot.caller.projectId,
          requestId: input.requestId,
          attemptId,
          supplyMode: candidate.authority.supplyMode,
          accountOwnerKind: candidate.authority.accountOwnerKind,
          publicModel: input.publicModel,
          protocol: 'openai',
          clientProtocol: 'openai',
          providerProtocol: 'openai',
          clientOperation: 'chat.completions',
          providerOperation: 'chat.completions',
          endpoint: authority.route.endpoint,
          upstreamId: candidate.authority.upstreamId,
          providerId: candidate.authority.providerId,
          productId: candidate.authority.productId,
          accountId: candidate.authority.accountId,
          credentialId: candidate.authority.credentialId,
          credentialVersion: String(candidate.authority.credentialVersion),
          payloadSha256,
          resolvedModel: payload.resolvedModel,
          payloadCompilerVersion: payload.compilerVersion,
        },
      };
      const ticket = Object.freeze({});
      this.#tickets.set(ticket, { bound, validate: assertFresh });
      heartbeat = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = lease
          .renew()
          .catch(() => {
            controller.abort();
          })
          .finally(() => {
            heartbeatPending = undefined;
          });
      }, lease.renewIntervalMs);
      heartbeat.unref();
      upstreamStarted = true;
      const response = await this.#credentials.run(
        {
          candidate,
          validate: async () => {
            assertFresh();
            if (!(await observeRequestDiagnosticPhase('fast-lease-check', () => lease.assertValid())))
              throw new Error('Fast lease expired');
            assertFresh();
          },
        },
        () => observeRequestDiagnosticPhase('fast-transport', () => this.#transport.sendFast(ticket)),
      );
      const status = response.resultHttpStatus ?? 502;
      responseStatus = status;
      await input.client.start(status, response.headers ?? {});
      const gate = new FastTerminalGate(
        input.client,
        (response.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream',
      );
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            await gate.write(next.value);
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      upstreamComplete = true;
      const succeeded = status >= 200 && status < 300;
      const usage: Record<string, string | null> = succeeded ? normalizedUsage(response) : {};
      let charge = 0n;
      if (succeeded && price) {
        const calculated = calculateFastReceiptCharge(priceSnapshot, usage);
        if (calculated > maxCost) throw new Error('Fast usage exceeds frozen price bound');
        charge = calculated;
      }
      // Capture complete scalar evidence before any terminal write. A failed or
      // ambiguous append must never be replaced by a conflicting unknown receipt.
      const receipt: FastReceiptInput = deepFreeze({
        intentId,
        requestId: input.requestId,
        tenantId: snapshot.caller.tenantId,
        outcome: succeeded ? 'succeeded' : 'failed',
        chargeMinorUnits: charge.toString(),
        usage,
        usageDigest: hash(canonical({ status, usage, charge: charge.toString() })),
        httpStatus: status,
        ...(succeeded && priceSnapshot ? { verification: { priceSnapshot } } : {}),
      });
      receiptState = 'captured';
      let completedTokenUnits: number | undefined;
      if (succeeded && usage.inputTotal != null && usage.outputTotal != null) {
        const total = BigInt(usage.inputTotal) + BigInt(usage.outputTotal);
        if (total >= 0n && total <= maxInput + maxOutput) completedTokenUnits = Number(total);
      }
      const queue = this.#options.receiptQueue;
      // The queue gets only an admission-owned scalar capability, never a
      // callback closing over this request, candidate, credentials or client.
      if (
        queue &&
        lease.releaseConcurrency &&
        lease.reconcileDurableUsage &&
        queue.tryEnqueue(receipt, {
          retainedLiabilityMinorUnits: maxCost.toString(),
          currency: price?.currency ?? null,
          ...(completedTokenUnits === undefined
            ? {}
            : {
                actualTokenUnits: completedTokenUnits,
                reconcileDurableUsage: lease.reconcileDurableUsage,
              }),
        })
      ) {
        receiptState = 'queued';
      } else {
        if (queue && (!lease.releaseConcurrency || !lease.reconcileDurableUsage)) queue.noteFallback();
        await observeRequestDiagnosticPhase('fast-receipt', () => this.#options.journal.appendReceipt(receipt));
        receiptState = 'durable';
        // Only durable, validated successful evidence may reconcile TPM. Queue
        // mode performs this in its worker, independently of concurrency release.
        actualTokenUnits = completedTokenUnits;
      }
      // EOF permits keep-alive clients to immediately reuse local HTTP capacity.
      // Finish request-owned operational I/O first, while a queued money receipt
      // and its durable TPM reconciliation remain independent background work.
      await cleanupOperationalLease();
      await gate.finish();
      return true;
    } catch (error) {
      if (intentId && receiptState === 'none') {
        const outcome = upstreamStarted ? 'unknown' : 'failed';
        await this.#options.journal
          .appendReceipt({
            intentId,
            requestId: input.requestId,
            tenantId: snapshot.caller.tenantId,
            outcome,
            chargeMinorUnits: outcome === 'failed' ? '0' : null,
            usage: {},
            usageDigest: hash(canonical({ outcome, requestId: input.requestId })),
            httpStatus: null,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await cleanupOperationalLease();
    }
  }
}
