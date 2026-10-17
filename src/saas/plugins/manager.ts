/**
 * Batch-5 §5.1 plugin manager — the DB-authoritative reconcile loop (sub2api
 * internal/service/plugin_manager.go port).
 *
 * Postgres is the single source of truth: the control plane writes
 * installations/bindings (admin surface), and every plugin-host replica
 * converges to that state once per second. The route snapshot published
 * from here is what the gateway's routing decorator consumes:
 *
 * - binding absent / rollout 0 → no route → native claude path;
 * - route available → forwarded through the plugin child;
 * - route UNAVAILABLE (DB unreadable, runtime unhealthy, spawn error,
 *   starting owned by another instance) → routed accounts FAIL CLOSED.
 *   Never a silent fallback to the native path: an operator enabled the
 *   plugin for those accounts, and bypassing it would change observable
 *   behavior without a signal.
 *
 * All state transitions are CAS through the store; a 0-row update is a
 * benign concurrent change and is simply re-read on the next tick.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderCredentialUnsealingKms } from '../credentials/provider-crypto.js';
import type { SqlExecutor } from '../db/types.js';
import { verifyPluginPackage, type PluginTrustedPublishers } from './package/verify.js';
import { PluginCredentialService } from './credentials.js';
import {
  createPluginHostServices,
  createPostgresPluginHostServicePorts,
  type PluginHostServices,
} from './host-services.js';
import { PluginRuntime, type PluginForwardStreamResult, type PluginRuntimeOptions } from './runtime.js';
import type { PluginForwardRequestWire } from './protocol.js';
import {
  PLUGIN_CAPABILITY_AUTHORIZATIONS,
  PLUGIN_CAPABILITY_IDS,
  PluginTransportError,
  type PluginBindingRecord,
  type PluginCapabilityId,
  type PluginInstallationRecord,
  type PluginRouteSnapshot,
  type PluginStore,
} from './types.js';

const DEFAULT_RECONCILE_INTERVAL_MS = 1_000;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const STARTING_RECOVERY_EXTRA_MS = 45_000;
const STARTING_RECOVERY_FLOOR_MS = 60_000;
const ERROR_RETRY_EXTRA_MS = 15_000;

export interface PluginManagerOptions {
  readonly store: PluginStore;
  readonly executor: SqlExecutor;
  readonly kms: ProviderCredentialUnsealingKms;
  /** Plugin data root; installations land in `<dataDir>/installed/<key>/<version>-<sha12>`. */
  readonly dataDir: string;
  readonly trustedPublishers: PluginTrustedPublishers;
  readonly allowUnsigned: boolean;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly reconcileIntervalMs?: number;
  readonly startTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly nowMs?: () => number;
  /** Test seam: replace the plugin runtime constructor. */
  readonly createRuntime?: (options: PluginRuntimeOptions) => PluginRuntime;
  /** Test seam: replace the host-service wiring (default: PG-backed ports). */
  readonly createHostServices?: (pluginKey: string) => PluginHostServices;
  /** Test seam: skip package re-extraction (default: verify + extract from artifact). */
  readonly resolveEntryPath?: (installation: PluginInstallationRecord) => Promise<string>;
}

interface ManagedRuntime {
  readonly runtime: PluginRuntime;
  readonly binarySha256: string;
  readonly configFingerprint: string;
  readonly rolloutPercent: number;
}

export class PluginManager {
  private readonly options: PluginManagerOptions & {
    readonly reconcileIntervalMs: number;
    readonly startTimeoutMs: number;
    readonly drainTimeoutMs: number;
    readonly nowMs: () => number;
  };
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly routes = new Map<PluginCapabilityId, PluginRouteSnapshot>();
  private readonly credentialService: PluginCredentialService;
  private operationChain: Promise<unknown> = Promise.resolve();
  private loopTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PluginManagerOptions) {
    this.options = {
      ...options,
      reconcileIntervalMs: options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      nowMs: options.nowMs ?? (() => Date.now()),
    };
    this.credentialService = new PluginCredentialService({
      executor: options.executor,
      kms: options.kms,
      deploymentId: options.deploymentId,
      environmentId: options.environmentId,
      getRoute: (capability) => this.routes.get(capability),
      nowMs: this.options.nowMs,
    });
  }

  async start(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'installed'), { recursive: true });
    this.loopTimer = setInterval(() => {
      void this.runOperation(() => this.reconcileOnce()).catch(() => undefined);
    }, this.options.reconcileIntervalMs);
    // Converge immediately on startup instead of waiting the first tick.
    await this.runOperation(() => this.reconcileOnce());
  }

  async stop(): Promise<void> {
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((entry) => entry.runtime.drain(this.options.drainTimeoutMs)));
    for (const capability of PLUGIN_CAPABILITY_IDS) this.routes.delete(capability);
  }

  getRoute(capability: PluginCapabilityId): PluginRouteSnapshot | undefined {
    return this.routes.get(capability);
  }

  routesSnapshot(): ReadonlyMap<PluginCapabilityId, PluginRouteSnapshot> {
    return this.routes;
  }

  /**
   * One full forward through the routed plugin: route check → scoped grant →
   * restricted unseal + session wrap → child forward stream.
   */
  async forward(wire: PluginForwardRequestWire, signal: AbortSignal): Promise<PluginForwardStreamResult> {
    const route = this.routes.get(wire.capability);
    if (route === undefined || !route.available) {
      throw new PluginTransportError(
        'PLUGIN_ROUTE_UNAVAILABLE',
        route?.unavailableReason ?? 'no plugin route is available for this capability',
        false,
      );
    }
    const managed = this.runtimes.get(route.pluginKey);
    if (managed === undefined || !managed.runtime.alive) {
      throw new PluginTransportError('PLUGIN_ROUTE_UNAVAILABLE', 'the routed plugin runtime is not serving', false);
    }
    let credentialEnvelope = null;
    if (wire.account.credential_id !== null) {
      const grant = this.credentialService.validateGrant({
        pluginKey: route.pluginKey,
        capability: wire.capability,
        accountId: wire.account.id,
      });
      credentialEnvelope = await this.credentialService.wrapCredentialForForward({
        grant,
        runtime: managed.runtime,
        requestId: wire.request_id,
        ownerKind: wire.account.owner_kind,
        tenantId: wire.account.tenant_id,
        accountId: wire.account.id,
        credentialId: wire.account.credential_id,
        credentialVersion: wire.account.credential_version,
      });
    }
    // Defense in depth: the authorization header is host-owned. Strip it no
    // matter what the caller sent — the plugin injects it from the session
    // envelope.
    const headers: Record<string, readonly string[]> = {};
    for (const [name, values] of Object.entries(wire.headers)) {
      if (name.toLowerCase() === 'authorization') continue;
      headers[name] = values;
    }
    const authorization = PLUGIN_CAPABILITY_AUTHORIZATIONS[wire.capability];
    return managed.runtime.forward({
      requestId: wire.request_id,
      method: wire.method,
      url: wire.url,
      headers,
      body: wire.body_base64 === null ? null : Buffer.from(wire.body_base64, 'base64'),
      account: { id: wire.account.id, platform: authorization.platform, account_type: authorization.accountType },
      credentialEnvelope,
      signal,
    });
  }

  /** Serialize admin-style operations against the reconcile loop. */
  async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private startingRecoveryDelayMs(): number {
    return Math.max(this.options.startTimeoutMs + STARTING_RECOVERY_EXTRA_MS, STARTING_RECOVERY_FLOOR_MS);
  }

  private startingExpired(installation: PluginInstallationRecord): boolean {
    const updated = Date.parse(installation.updatedAt);
    if (!Number.isFinite(updated)) return true;
    return this.options.nowMs() - updated > this.startingRecoveryDelayMs();
  }

  private async reconcileOnce(): Promise<void> {
    let installations: PluginInstallationRecord[];
    try {
      installations = await this.options.store.listInstallations();
    } catch {
      // DB unreadable: publish unavailable for every capability that has a
      // route today and detach runtimes. NEVER assume "no plugins" — that
      // would silently route plugin traffic onto the native path.
      for (const capability of PLUGIN_CAPABILITY_IDS) {
        const route = this.routes.get(capability);
        if (route !== undefined) {
          this.routes.set(capability, {
            ...route,
            available: false,
            unavailableReason: 'plugin enabled state could not be read',
          });
        }
      }
      await this.drainAllRuntimes();
      return;
    }
    await this.cleanupStaleLocalInstallations(installations);
    let bindings: PluginBindingRecord[];
    try {
      bindings = await this.options.store.listBindings();
    } catch {
      for (const capability of PLUGIN_CAPABILITY_IDS) {
        const route = this.routes.get(capability);
        if (route !== undefined) {
          this.routes.set(capability, {
            ...route,
            available: false,
            unavailableReason: 'plugin bindings could not be read',
          });
        }
      }
      await this.drainAllRuntimes();
      return;
    }

    const livePluginKeys = new Set<string>();
    for (const capability of PLUGIN_CAPABILITY_IDS) {
      const enabled = bindings.filter(
        (binding) => binding.capability === capability && binding.enabled && binding.rolloutPercent > 0,
      );
      if (enabled.length === 0) {
        this.routes.delete(capability);
        continue;
      }
      if (enabled.length > 1) {
        // The partial unique index makes this unreachable; treat defensively.
        this.routes.set(capability, {
          capability,
          pluginKey: enabled[0].pluginKey,
          rolloutPercent: enabled[0].rolloutPercent,
          available: false,
          unavailableReason: 'multiple enabled plugins for one capability',
        });
        continue;
      }
      const binding = enabled[0];
      const installation = installations.find((candidate) => candidate.id === binding.installationId);
      if (installation === undefined) {
        this.routes.set(capability, {
          capability,
          pluginKey: binding.pluginKey,
          rolloutPercent: binding.rolloutPercent,
          available: false,
          unavailableReason: 'the enabled plugin installation is missing',
        });
        continue;
      }
      livePluginKeys.add(installation.pluginKey);
      await this.reconcileCapabilityRoute(capability, installation, binding);
    }
    // Any runtime whose plugin is no longer routed gets drained.
    for (const [pluginKey, managed] of this.runtimes) {
      if (!livePluginKeys.has(pluginKey)) {
        this.runtimes.delete(pluginKey);
        void managed.runtime.drain(this.options.drainTimeoutMs).catch(() => undefined);
      }
    }
  }

  private async reconcileCapabilityRoute(
    capability: PluginCapabilityId,
    installation: PluginInstallationRecord,
    binding: PluginBindingRecord,
  ): Promise<void> {
    const publish = (available: boolean, reason: string | null) => {
      this.routes.set(capability, {
        capability,
        pluginKey: installation.pluginKey,
        rolloutPercent: binding.rolloutPercent,
        available,
        unavailableReason: reason,
      });
    };

    // Starting-timeout reclaim: another instance owned the start and never
    // finished; take the row back so THIS instance can retry.
    if (installation.state === 'starting' && this.startingExpired(installation)) {
      const reclaimed = await this.options.store.updateInstallationState({
        id: installation.id,
        expectedState: 'starting',
        expectedBinarySha256: installation.binarySha256,
        state: 'disabled',
        lastError: 'plugin start timed out; auto-recovered to disabled',
      });
      if (reclaimed !== null) {
        installation = reclaimed;
      } else {
        const fresh = await this.options.store.getInstallation(installation.pluginKey);
        if (fresh !== null) installation = fresh;
      }
    }

    const managed = this.runtimes.get(installation.pluginKey);
    const configFingerprint = fingerprintConfig(installation.configJson);

    // Fast path: live runtime, same binary/config/rollout → health probe.
    if (
      managed !== undefined &&
      managed.runtime.alive &&
      managed.binarySha256 === installation.binarySha256 &&
      managed.configFingerprint === configFingerprint &&
      managed.rolloutPercent === binding.rolloutPercent
    ) {
      const healthy = await managed.runtime.checkHealth(DEFAULT_HEALTH_TIMEOUT_MS);
      if (healthy) {
        publish(true, null);
        if (installation.state === 'error' || installation.state === 'starting') {
          await this.options.store.markRuntimeHealthy({
            id: installation.id,
            expectedBinarySha256: installation.binarySha256,
          });
        }
        return;
      }
      this.runtimes.delete(installation.pluginKey);
      await managed.runtime.drain(this.options.drainTimeoutMs);
      publish(false, 'plugin health check failed');
      return;
    }

    // NOTE: unlike sub2api (where the admin process spawns synchronously and
    // a fresh `starting` row means "another instance owns the spawn"), the
    // split plugin-host model has no other spawner — every plugin-host
    // ADOPTS any starting row immediately. Concurrent adoption is safe:
    // only one markRuntimeHealthy CAS can win, and losers drain the runtime
    // they just started (the re-read guard below).

    // Error backoff: a spawn that just failed is not retried every tick.
    if (
      installation.state === 'error' &&
      managed === undefined &&
      Date.parse(installation.updatedAt) + this.options.startTimeoutMs + ERROR_RETRY_EXTRA_MS > this.options.nowMs()
    ) {
      publish(false, installation.lastError !== '' ? installation.lastError : 'plugin failed to start');
      return;
    }

    // Slow path: (re)extract + spawn + validate + CAS healthy + swap in.
    let runtime: PluginRuntime;
    try {
      const entryPath = await (this.options.resolveEntryPath?.(installation) ??
        this.ensureLocalInstallation(installation));
      const createRuntime =
        this.options.createRuntime ??
        ((runtimeOptions: PluginRuntimeOptions) => new PluginRuntime(runtimeOptions));
      const createHostServices =
        this.options.createHostServices ??
        ((pluginKey: string) => {
          const ports = createPostgresPluginHostServicePorts(this.options.executor);
          return createPluginHostServices({ pluginKey, kv: ports.kv, accounts: ports.accounts });
        });
      runtime = createRuntime({
        pluginKey: installation.pluginKey,
        version: installation.version,
        entryPath,
        binarySha256: installation.binarySha256,
        config: installation.configJson === null ? null : { ...installation.configJson },
        hostServices: createHostServices(installation.pluginKey),
        startTimeoutMs: this.options.startTimeoutMs,
      });
      await runtime.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'plugin failed to start';
      await this.options.store
        .updateInstallationState({
          id: installation.id,
          expectedState: null,
          expectedBinarySha256: installation.binarySha256,
          state: 'error',
          lastError: message.slice(0, 2000),
        })
        .catch(() => undefined);
      publish(false, message);
      return;
    }

    // Re-read the DB: bindings/binary/config may have changed while the
    // (slow) start was in flight. A concurrent admin DISABLE is caught by
    // the binding re-check (disable clears the enabled binding); the
    // markRuntimeHealthy CAS below is the final authority.
    const fresh = await this.options.store.getInstallation(installation.pluginKey);
    const freshBindings = await this.options.store.listBindings();
    const freshBinding = freshBindings.find(
      (candidate) =>
        candidate.capability === capability && candidate.enabled && candidate.installationId === installation.id,
    );
    if (
      fresh === null ||
      fresh.binarySha256 !== installation.binarySha256 ||
      fingerprintConfig(fresh.configJson) !== configFingerprint ||
      freshBinding === undefined ||
      freshBinding.rolloutPercent !== binding.rolloutPercent
    ) {
      await runtime.drain(this.options.drainTimeoutMs);
      publish(false, 'plugin state changed during start');
      return;
    }
    const healthy = await this.options.store.markRuntimeHealthy({
      id: installation.id,
      expectedBinarySha256: installation.binarySha256,
    });
    if (!healthy) {
      await runtime.drain(this.options.drainTimeoutMs);
      publish(false, 'plugin state changed during start');
      return;
    }
    const previous = this.runtimes.get(installation.pluginKey);
    this.runtimes.set(installation.pluginKey, {
      runtime,
      binarySha256: installation.binarySha256,
      configFingerprint,
      rolloutPercent: freshBinding.rolloutPercent,
    });
    if (previous !== undefined && previous.runtime !== runtime) {
      void previous.runtime.drain(this.options.drainTimeoutMs).catch(() => undefined);
    }
    publish(true, null);
  }

  /**
   * Deterministic local install dir: `<dataDir>/installed/<key>/<version>-<sha12>`.
   * Fast path verifies the entrypoint hash (the sub2api
   * verifyLocalPluginBinary rule); otherwise the original signed package is
   * re-verified in full and re-extracted atomically.
   */
  private async ensureLocalInstallation(installation: PluginInstallationRecord): Promise<string> {
    const dir = join(
      this.options.dataDir,
      'installed',
      installation.pluginKey,
      `${installation.version}-${installation.binarySha256.slice(0, 12)}`,
    );
    const entryPath = join(dir, installation.entrypointPath);
    try {
      const bytes = await readFile(entryPath);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual === installation.binarySha256) return entryPath;
    } catch {
      // fall through to re-extract
    }
    await rm(dir, { recursive: true, force: true });
    const tempDir = `${dir}.install-${cryptoRandomSuffix()}`;
    await mkdir(tempDir, { recursive: true });
    try {
      const verified = await verifyPluginPackage({
        data: installation.artifactData,
        trustedPublishers: this.options.trustedPublishers,
        allowUnsigned: this.options.allowUnsigned,
      });
      if (
        verified.manifestSha256 !== installation.manifestSha256 ||
        verified.entrypointSha256 !== installation.binarySha256
      ) {
        throw new PluginTransportError(
          'PACKAGE_IDENTITY_MISMATCH',
          'stored package no longer matches its installation row',
          false,
        );
      }
      await verified.extractTo(tempDir);
      await rename(tempDir, dir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
    return join(dir, installation.entrypointPath);
  }

  private async cleanupStaleLocalInstallations(installations: PluginInstallationRecord[]): Promise<void> {
    const root = join(this.options.dataDir, 'installed');
    let pluginDirs: string[];
    try {
      pluginDirs = await readdir(root);
    } catch {
      return;
    }
    for (const pluginKey of pluginDirs) {
      const installation = installations.find((candidate) => candidate.pluginKey === pluginKey);
      if (installation === undefined) {
        await rm(join(root, pluginKey), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      const expected = `${installation.version}-${installation.binarySha256.slice(0, 12)}`;
      let versionDirs: string[];
      try {
        versionDirs = await readdir(join(root, pluginKey));
      } catch {
        continue;
      }
      for (const versionDir of versionDirs) {
        if (versionDir !== expected) {
          await rm(join(root, pluginKey, versionDir), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  }

  private async drainAllRuntimes(): Promise<void> {
    const entries = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(entries.map((entry) => entry.runtime.drain(this.options.drainTimeoutMs)));
  }
}

function fingerprintConfig(config: Readonly<Record<string, unknown>> | null): string {
  if (config === null) return 'null';
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function cryptoRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
