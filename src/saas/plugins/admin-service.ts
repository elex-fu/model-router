/**
 * Batch-5 §5.1 plugin admin service — the control-plane half of the plugin
 * lifecycle. sub2api's PluginManager performs install/enable/disable in the
 * SAME process that spawns plugins; under the separate plugin-host workload
 * decision (types.ts decision #1) the control plane NEVER spawns a plugin.
 * It owns only the authoritative DB state; the plugin-host's reconcile loop
 * converges to it within one tick and reports spawn failures back through
 * the `error` state (the admin surfaces poll it).
 *
 * Consequences encoded here:
 * - enable is a DB transition (state → starting, bindings enabled), not a
 *   spawn: the admin API cannot tell whether the plugin actually boots;
 *   operators watch state + last_error.
 * - config changes are refused while a plugin is enabled/starting (no live
 *   ApplyConfig rollback dance across process boundaries — disable first).
 * - delete is refused while enabled/starting or with an enabled binding.
 */

import { createHash } from 'node:crypto';
import { verifyPluginPackage, type PluginTrustedPublishers } from './package/verify.js';
import { evaluatePluginCompatibility } from './package/manifest.js';
import { PLUGIN_CAPABILITY_AUTHORIZATIONS, type PluginInstallationRecord, type PluginStore } from './types.js';

export type PluginAdminErrorCode =
  | 'PACKAGE_INVALID'
  | 'UNSIGNED_REJECTED'
  | 'INCOMPATIBLE'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'REPLACE_FORBIDDEN'
  | 'DELETE_FORBIDDEN'
  | 'INVALID_ROLLOUT';

export class PluginAdminError extends Error {
  constructor(
    readonly code: PluginAdminErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'PluginAdminError';
  }
}

export interface PluginAdminServiceOptions {
  readonly store: PluginStore;
  readonly trustedPublishers: PluginTrustedPublishers;
  readonly allowUnsigned: boolean;
  readonly maxUploadBytes?: number;
}

export class PluginAdminService {
  private readonly options: PluginAdminServiceOptions;

  constructor(options: PluginAdminServiceOptions) {
    this.options = options;
  }

  /** Verify + persist a `.mrplugin` upload (insert or versioned replace). */
  async install(packageBytes: Uint8Array, actorUserId: string | null): Promise<PluginInstallationRecord> {
    let verified;
    try {
      verified = await verifyPluginPackage({
        data: packageBytes,
        trustedPublishers: this.options.trustedPublishers,
        allowUnsigned: this.options.allowUnsigned,
        maxUploadBytes: this.options.maxUploadBytes,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'package verification failed';
      throw new PluginAdminError('PACKAGE_INVALID', 'The plugin package failed verification', detail);
    }
    const compatibility = evaluatePluginCompatibility(verified.manifest);
    let record: PluginInstallationRecord;
    try {
      record = await this.options.store.upsertInstallation({
        pluginKey: verified.manifest.id,
        name: verified.manifest.name,
        version: verified.manifest.version,
        description: verified.manifest.description,
        author: verified.manifest.author,
        manifest: verified.manifest,
        manifestSha256: verified.manifestSha256,
        entrypointPath: verified.manifest.entrypoint,
        binarySha256: verified.entrypointSha256,
        signatureStatus: verified.signatureStatus,
        artifactData: packageBytes,
        artifactSha256: sha256Hex(packageBytes),
        installedBy: actorUserId,
      });
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === 'plugin_replace_forbidden') {
        throw new PluginAdminError(
          'REPLACE_FORBIDDEN',
          'Disable the current plugin version before uploading a replacement',
        );
      }
      throw error;
    }
    if (compatibility.state === 'incompatible') {
      const updated = await this.options.store.updateInstallationState({
        id: record.id,
        expectedState: null,
        expectedBinarySha256: record.binarySha256,
        state: 'incompatible',
        lastError: compatibility.reason ?? 'plugin is incompatible with this host',
      });
      if (updated !== null) return updated;
      const fresh = await this.options.store.getInstallation(record.pluginKey);
      if (fresh !== null) return fresh;
    }
    return record;
  }

  async list(): Promise<PluginInstallationRecord[]> {
    return this.options.store.listInstallations();
  }

  async get(pluginKey: string): Promise<PluginInstallationRecord> {
    const record = await this.options.store.getInstallation(pluginKey);
    if (record === null) throw new PluginAdminError('NOT_FOUND', 'The plugin is not installed');
    return record;
  }

  /**
   * Enable for the capability scope with a stable rollout percent. The
   * plugin-host picks the `starting` row up within one reconcile tick.
   */
  async enable(pluginKey: string, rolloutPercent: number): Promise<PluginInstallationRecord> {
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 1 || rolloutPercent > 100) {
      throw new PluginAdminError('INVALID_ROLLOUT', 'Rollout percent must be an integer between 1 and 100');
    }
    const record = await this.get(pluginKey);
    if (record.state === 'incompatible' || record.state === 'starting' || record.state === 'enabled') {
      throw new PluginAdminError('INVALID_STATE', `The plugin cannot be enabled from state ${record.state}`);
    }
    const updated = await this.options.store.updateInstallationState({
      id: record.id,
      expectedState: record.state,
      expectedBinarySha256: record.binarySha256,
      state: 'starting',
      lastError: '',
    });
    if (updated === null) {
      throw new PluginAdminError('INVALID_STATE', 'The plugin state changed concurrently; retry');
    }
    await this.options.store.replaceBindings({
      installationId: record.id,
      bindings: record.manifest.capabilities.map((capability) => ({
        capability: capability.id,
        platform: PLUGIN_CAPABILITY_AUTHORIZATIONS[capability.id].platform,
        accountType: PLUGIN_CAPABILITY_AUTHORIZATIONS[capability.id].accountType,
        enabled: true,
        rolloutPercent,
      })),
    });
    return (await this.options.store.getInstallation(pluginKey)) ?? updated;
  }

  async disable(pluginKey: string): Promise<PluginInstallationRecord> {
    const record = await this.get(pluginKey);
    if (record.state === 'disabled') return record;
    const updated = await this.options.store.updateInstallationState({
      id: record.id,
      expectedState: null,
      expectedBinarySha256: record.binarySha256,
      state: 'disabled',
      lastError: record.lastError,
    });
    if (updated === null) throw new PluginAdminError('INVALID_STATE', 'The plugin state changed concurrently; retry');
    await this.options.store.replaceBindings({
      installationId: record.id,
      bindings: record.manifest.capabilities.map((capability) => ({
        capability: capability.id,
        platform: PLUGIN_CAPABILITY_AUTHORIZATIONS[capability.id].platform,
        accountType: PLUGIN_CAPABILITY_AUTHORIZATIONS[capability.id].accountType,
        enabled: false,
        rolloutPercent: 100,
      })),
    });
    return (await this.options.store.getInstallation(pluginKey)) ?? updated;
  }

  /** Config changes are offline-only: disable first, then update. */
  async updateConfig(
    pluginKey: string,
    config: Readonly<Record<string, unknown>> | null,
  ): Promise<PluginInstallationRecord> {
    const record = await this.get(pluginKey);
    if (record.state === 'starting' || record.state === 'enabled') {
      throw new PluginAdminError('INVALID_STATE', 'Disable the plugin before changing its configuration');
    }
    const updated = await this.options.store.updateConfigJson({ id: record.id, configJson: config });
    if (updated === null) throw new PluginAdminError('INVALID_STATE', 'The plugin state changed concurrently; retry');
    return updated;
  }

  async delete(pluginKey: string): Promise<void> {
    const record = await this.get(pluginKey);
    if (record.state === 'starting' || record.state === 'enabled') {
      throw new PluginAdminError('DELETE_FORBIDDEN', 'Disable the plugin before deleting it');
    }
    const bindings = await this.options.store.listBindings();
    if (bindings.some((binding) => binding.installationId === record.id && binding.enabled)) {
      throw new PluginAdminError('DELETE_FORBIDDEN', 'The plugin still has an enabled binding');
    }
    const deleted = await this.options.store.deleteInstallation(record.id);
    if (!deleted) throw new PluginAdminError('NOT_FOUND', 'The plugin is not installed');
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
