import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { fetch as undiciFetch } from 'undici';
import {
  createPinnedProviderHttpConnector,
  createPinnedProviderHttpTestConnectorFactory,
  isLoopbackProviderAddress,
  isProviderHttpTestAddressCapability,
  ProviderHttpAddressPolicyError,
  resolveProviderHttpAddresses,
  selectPinnedProviderAddress,
  type ProviderHttpAddressResolver,
  type ProviderHttpPinnedConnector,
  type ProviderHttpTestAddressCapability,
} from '../gateway/provider-http-address.js';
import {
  createCredentialValidationProbeRequest,
  PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS,
  readCredentialValidationProbeResponse,
  type CredentialValidationProbe,
  type ProviderCredentialValidationResult,
} from './credential-validation-adapters.js';
import {
  credentialValidationTargetRequestUrl,
  isApprovedCredentialValidationBinding,
} from './credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from './types.js';

declare const preparedProbeBrand: unique symbol;
export interface PreparedCredentialValidationProbe { readonly [preparedProbeBrand]: true; }

/** None of these seams can be enabled without the existing test-runner-only CA capability. */
export interface CredentialValidationTransportTestOptions {
  readonly addressCapability: ProviderHttpTestAddressCapability;
  readonly resolveAddresses?: ProviderHttpAddressResolver;
  readonly timeoutMs?: number;
}

export type CredentialValidationTransportErrorCode =
  | 'provider_address_rejected' | 'provider_timeout' | 'provider_network_error' | 'validation_transport_closed';

export class CredentialValidationTransportError extends Error {
  constructor(readonly code: CredentialValidationTransportErrorCode) {
    super('Credential validation transport is unavailable');
    this.name = 'CredentialValidationTransportError';
  }
}

interface ProbeState {
  readonly controller: AbortController;
  readonly unlink: () => void;
  readonly binding: Readonly<ApprovedCredentialValidationTarget>;
  readonly url: URL;
  connector?: ProviderHttpPinnedConnector;
  timer?: NodeJS.Timeout;
  consumed: boolean;
  disposed: boolean;
  cleanup?: Promise<void>;
}

function closed(): never { throw new CredentialValidationTransportError('validation_transport_closed'); }

/** Race DNS as well as HTTP: node:dns lookup itself has no cancellation parameter. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/**
 * Custom validation always uses the local Undici implementation with a private
 * per-probe pinned Agent. There is deliberately no fetch/dispatcher/proxy/header
 * injection seam in production and no redirects or ambient client identity.
 */
export class CredentialValidationHttpTransport {
  private readonly halt = new AbortController();
  private readonly plans = new WeakMap<object, ProbeState>();
  private readonly active = new Set<ProbeState>();
  private readonly resolver: ProviderHttpAddressResolver;
  private readonly timeoutMs: number;
  private closePromise?: Promise<void>;

  constructor(private readonly testOptions?: CredentialValidationTransportTestOptions) {
    if (testOptions && (!isProviderHttpTestAddressCapability(testOptions.addressCapability) ||
      Object.keys(testOptions).some((field) => !['addressCapability', 'resolveAddresses', 'timeoutMs'].includes(field)))) {
      throw new TypeError('Credential validation test transport requires a test-runner capability');
    }
    this.testOptions = testOptions ? Object.freeze({ ...testOptions }) : undefined;
    this.resolver = testOptions?.resolveAddresses ?? resolveProviderHttpAddresses;
    this.timeoutMs = testOptions?.timeoutMs ?? PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > PROVIDER_CREDENTIAL_VALIDATION_TIMEOUT_MS) {
      throw new TypeError('Credential validation transport deadline is invalid');
    }
  }

  private checkOpen(signal?: AbortSignal): void {
    if (this.halt.signal.aborted || signal?.aborted) closed();
    if (this.testOptions && !isProviderHttpTestAddressCapability(this.testOptions.addressCapability)) closed();
  }

  private deadline(state: ProbeState): void {
    state.timer = setTimeout(() => state.controller.abort(new CredentialValidationTransportError('provider_timeout')), this.timeoutMs);
  }

  private stopDeadline(state: ProbeState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }

  async prepare(binding: Readonly<ApprovedCredentialValidationTarget>, signal?: AbortSignal): Promise<PreparedCredentialValidationProbe> {
    this.checkOpen(signal);
    if (!isApprovedCredentialValidationBinding(binding) ||
      (binding.expiresAt !== null && Date.parse(binding.expiresAt) <= Date.now())) {
      throw new CredentialValidationTransportError('provider_address_rejected');
    }
    const url = credentialValidationTargetRequestUrl(binding);
    const controller = new AbortController();
    const stop = () => controller.abort(new CredentialValidationTransportError('validation_transport_closed'));
    this.halt.signal.addEventListener('abort', stop, { once: true });
    signal?.addEventListener('abort', stop, { once: true });
    const state: ProbeState = {
      binding, url, controller, consumed: false, disposed: false,
      unlink: () => { this.halt.signal.removeEventListener('abort', stop); signal?.removeEventListener('abort', stop); },
    };
    this.active.add(state);
    this.deadline(state);
    try {
      this.checkOpen(signal);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const answers = isIP(hostname) ? [] : await untilAbort(this.resolver(hostname, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      if (!Array.isArray(answers) || answers.length > 64) throw new ProviderHttpAddressPolicyError();
      const address = selectPinnedProviderAddress(hostname, answers, this.testOptions?.addressCapability);
      const connectorFactory = this.testOptions && isLoopbackProviderAddress(hostname)
        ? createPinnedProviderHttpTestConnectorFactory(this.testOptions.addressCapability)
        : createPinnedProviderHttpConnector;
      state.connector = connectorFactory({ hostname, port: Number(url.port || 443), ...address });
      this.stopDeadline(state);
      const plan = Object.freeze(Object.create(null)) as PreparedCredentialValidationProbe;
      this.plans.set(plan, state);
      return plan;
    } catch (error) {
      await this.dispose(state);
      if (error instanceof CredentialValidationTransportError) throw error;
      if (this.halt.signal.aborted || signal?.aborted) closed();
      if (controller.signal.reason instanceof CredentialValidationTransportError) throw controller.signal.reason;
      throw new CredentialValidationTransportError(error instanceof ProviderHttpAddressPolicyError
        ? 'provider_address_rejected' : 'provider_network_error');
    }
  }

  async probe(
    plan: PreparedCredentialValidationProbe,
    secret: Buffer,
    recheckBeforeDispatch: () => Promise<void>,
  ): Promise<ProviderCredentialValidationResult> {
    this.checkOpen();
    const state = this.plans.get(plan);
    if (!state || state.disposed || state.consumed || !state.connector) closed();
    state.consumed = true;
    const probe: CredentialValidationProbe = {
      adapterId: state.binding.productId === 'custom-openai' ? 'custom-openai-chat-v1' : 'custom-anthropic-messages-v1',
      model: state.binding.model, kind: state.binding.endpoint === 'messages' ? 'messages' : 'chat', custom: true,
    };
    const startedAt = performance.now();
    const failure = (code: 'credential_format_invalid' | 'provider_timeout' | 'provider_network_error'): ProviderCredentialValidationResult => ({
      state: 'failed', errorCode: code, retryable: code !== 'credential_format_invalid',
      adapterId: probe.adapterId, httpStatus: null, durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    this.deadline(state);
    try {
      const request = createCredentialValidationProbeRequest(probe, secret);
      if (!request) return failure('credential_format_invalid');
      // Do not catch/convert lease or authority failures into credential errors.
      await recheckBeforeDispatch();
      this.checkOpen();
      state.controller.signal.throwIfAborted();
      if (state.binding.expiresAt !== null && Date.parse(state.binding.expiresAt) <= Date.now()) closed();
      try {
        const response = await undiciFetch(state.url, {
          ...request, headers: { ...request.headers }, signal: state.controller.signal,
          dispatcher: state.connector.dispatcher, redirect: 'manual',
        });
        const result = await readCredentialValidationProbeResponse(probe, response, state.controller.signal, startedAt);
        this.checkOpen();
        return result;
      } catch {
        this.checkOpen();
        return failure(state.controller.signal.aborted ? 'provider_timeout' : 'provider_network_error');
      }
    } finally {
      this.plans.delete(plan);
      await this.dispose(state);
    }
  }

  async release(plan: PreparedCredentialValidationProbe): Promise<void> {
    const state = this.plans.get(plan);
    this.plans.delete(plan);
    if (state) await this.dispose(state);
  }

  private dispose(state: ProbeState): Promise<void> {
    if (state.cleanup) return state.cleanup;
    state.disposed = true;
    this.stopDeadline(state);
    state.unlink();
    this.active.delete(state);
    // An Agent is never pooled across probes or destinations. destroy also
    // terminates a rejected/cancelled response without an unbounded drain.
    state.cleanup = state.connector ? state.connector.destroy().catch(() => undefined) : Promise.resolve();
    return state.cleanup;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.halt.abort(new CredentialValidationTransportError('validation_transport_closed'));
    this.closePromise = Promise.all([...this.active].map((state) => this.dispose(state))).then(() => undefined);
    return this.closePromise;
  }
}
